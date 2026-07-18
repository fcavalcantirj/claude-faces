// Agent-bridge adapter — Mode B. Instead of a fresh, stateless hosted API, this
// wires the face to an agent you are ALREADY running, so it reuses that agent's
// memory, tools, and persona. The concrete agent is chosen by AGENT_BRIDGE_KIND:
//
//   • ollama            — POST {url}/api/chat (stream:true, NDJSON); models via
//                         {url}/api/tags. Stateless per call → full history sent.
//   • hermes            — Hermes `api_server` session flow: ensureSession via
//                         POST {url}/api/sessions, then POST
//                         {url}/api/sessions/{id}/chat with X-Hermes-Session-Key.
//                         Stateful → we send ONLY the latest user turn (the agent
//                         keeps the thread), not the whole history.
//   • openclaw          } OpenAI-compatible bridges: POST {url}/v1/chat/completions
//   • claude-code       } parsed as SSE. These expose the running agent behind a
//   • openai-compatible } standard chat-completions endpoint.
//
// Reachability (see docs/env-contract.md): a configured endpoint is usable in
// localhost dev and on self-host/VPS (Mode B lives next to the agent on the
// private network — no tunnel). On Vercel (serverless) it is exposed ONLY when
// ALLOW_AGENT_BRIDGE_IN_PROD=1 or AGENT_BRIDGE_URL is a public HTTPS/tunnel URL,
// because a serverless function cannot reach a private `localhost` address.
//
// `available()` is a PURE read of the env snapshot (no network probe). The actual
// "is the agent up?" check happens at stream time: an unreachable endpoint throws
// a clear "agent offline" AdapterError. `fetch` is injected via `deps` so the
// whole adapter is headlessly unit-testable with no live agent and no network.

import { errorForStatus, isAbort, normalizeError, parseSSEStream } from '@/lib/providers/sse'
import {
  AdapterError,
  type ChatAdapter,
  type ChatMessage,
  type ChatRequest,
  type ModelInfo,
  type ProviderEnv,
  type StreamEvent,
} from '@/lib/providers/types'

/** Stable registry id + label. */
const ID = 'agent-bridge'
const LABEL = 'Agent bridge (your running agent)'

/** Output ceiling for the OpenAI-compatible kinds — the face SPEAKS its reply. */
const MAX_TOKENS = 4096

/** Ollama's conventional local endpoint, used when no URL is configured. */
const OLLAMA_DEFAULT_URL = 'http://localhost:11434'

/** The running-agent kinds this bridge can front. */
type BridgeKind = 'hermes' | 'openclaw' | 'claude-code' | 'ollama' | 'openai-compatible'
const KINDS: readonly BridgeKind[] = [
  'hermes',
  'openclaw',
  'claude-code',
  'ollama',
  'openai-compatible',
]

// ---------------------------------------------------------------------------
// Pure env resolution (used by `available`, `listModels`, and `streamChat`)
// ---------------------------------------------------------------------------

/** Resolve the configured bridge kind, or `undefined` when none applies. */
function resolveKind(env: ProviderEnv): BridgeKind | undefined {
  const raw = env.AGENT_BRIDGE_KIND?.trim().toLowerCase()
  if (raw && (KINDS as readonly string[]).includes(raw)) return raw as BridgeKind
  // Convenience: a Hermes base URL alone implies the `hermes` kind.
  if (!raw && env.HERMES_API_BASE_URL?.trim()) return 'hermes'
  return undefined
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Resolve the agent's base URL. `hermes` prefers the HERMES_API_BASE_URL alias
 * and falls back to AGENT_BRIDGE_URL; `ollama` falls back to its conventional
 * local endpoint. Returns `undefined` when nothing is configured.
 */
function resolveBaseUrl(env: ProviderEnv, kind: BridgeKind): string | undefined {
  let url =
    kind === 'hermes'
      ? env.HERMES_API_BASE_URL?.trim() || env.AGENT_BRIDGE_URL?.trim()
      : env.AGENT_BRIDGE_URL?.trim()
  if (!url && kind === 'ollama') url = OLLAMA_DEFAULT_URL
  return url && url.length > 0 ? stripTrailingSlash(url) : undefined
}

/** Resolve the auth key. `hermes` prefers the HERMES_API_KEY alias. */
function resolveKey(env: ProviderEnv, kind: BridgeKind): string | undefined {
  const key =
    kind === 'hermes'
      ? env.HERMES_API_KEY?.trim() || env.AGENT_BRIDGE_KEY?.trim()
      : env.AGENT_BRIDGE_KEY?.trim()
  return key && key.length > 0 ? key : undefined
}

/** Resolve the model/thread the bridged agent should use, if applicable. */
function resolveModel(env: ProviderEnv): string | undefined {
  const m = env.AGENT_BRIDGE_MODEL?.trim()
  return m && m.length > 0 ? m : undefined
}

/** True when we are running on Vercel's serverless platform. */
function isVercel(env: ProviderEnv): boolean {
  return env.VERCEL === '1' || Boolean(env.VERCEL_ENV?.trim())
}

/**
 * True only for a URL a Vercel serverless function could actually reach: HTTPS,
 * and not pointed at localhost or a private-network (RFC 1918 / link-local) host.
 */
function isPublicHttpsUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return false
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return false
  if (/^10\./.test(h)) return false
  if (/^192\.168\./.test(h)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
  return true
}

/**
 * Pure availability: a valid kind + reachable-in-this-environment endpoint. On
 * Vercel a private endpoint is HIDDEN unless explicitly permitted; localhost dev
 * and self-host reach a private agent directly.
 */
function bridgeAvailable(env: ProviderEnv): boolean {
  const kind = resolveKind(env)
  if (!kind) return false
  const url = resolveBaseUrl(env, kind)
  if (!url) return false
  // Self-host lives next to the agent on the private network — always reachable.
  if (env.SELF_HOST === '1') return true
  if (isVercel(env)) {
    return env.ALLOW_AGENT_BRIDGE_IN_PROD === '1' || isPublicHttpsUrl(url)
  }
  return true
}

// ---------------------------------------------------------------------------
// Robust delta extraction across the bridge's various response shapes
// ---------------------------------------------------------------------------

interface AnyChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
  message?: { content?: string | null }
  response?: string | null
  delta?: string | null
  content?: string | null
  done?: boolean
  done_reason?: string | null
  type?: string
}

/** Pull the incremental assistant text out of one parsed frame, if any. */
function extractDelta(obj: AnyChunk): string | undefined {
  const oc = obj.choices?.[0]?.delta?.content // OpenAI-compatible
  if (typeof oc === 'string' && oc.length > 0) return oc
  const mc = obj.message?.content // Ollama / Hermes chat
  if (typeof mc === 'string' && mc.length > 0) return mc
  if (typeof obj.response === 'string' && obj.response.length > 0) return obj.response // generate-style
  if (typeof obj.delta === 'string' && obj.delta.length > 0) return obj.delta
  if (typeof obj.content === 'string' && obj.content.length > 0) return obj.content
  return undefined
}

/** Pull a stop/finish reason out of one parsed frame, if present. */
function extractFinish(obj: AnyChunk): string | undefined {
  const fr = obj.choices?.[0]?.finish_reason
  if (typeof fr === 'string' && fr.length > 0) return fr
  if (typeof obj.done_reason === 'string' && obj.done_reason.length > 0) return obj.done_reason
  return undefined
}

/** True when a frame marks end-of-stream at the object level. */
function isDoneEvent(obj: AnyChunk): boolean {
  if (obj.done === true) return true
  if (obj.type === 'done') return true
  const fr = obj.choices?.[0]?.finish_reason
  return typeof fr === 'string' && fr.length > 0
}

/** The latest user turn — what a stateful agent needs (it holds the rest). */
function lastUserContent(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

// ---------------------------------------------------------------------------
// Transports — NDJSON (Ollama) and the shared SSE parser (openai-compatible)
// ---------------------------------------------------------------------------

/** Parse an NDJSON byte stream into successive non-empty line strings. */
async function* parseNDJSON(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (line) yield line
      }
    }
    const tail = (buf + decoder.decode()).trim()
    if (tail) yield tail
  } catch (err) {
    if (isAbort(err)) {
      throw new AdapterError('aborted', 'The stream was aborted.', { provider: ID, cause: err })
    }
    throw new AdapterError('upstream_error', 'The bridged agent stream failed.', {
      provider: ID,
      cause: err,
    })
  } finally {
    reader.releaseLock()
  }
}

/**
 * Drive a stream of JSON frame strings into `StreamEvent`s. Shared by every
 * kind: it extracts deltas robustly, honors barge-in, and emits a final `done`.
 */
async function* pumpJsonEvents(
  frames: AsyncGenerator<string> | AsyncGenerator<string, void, unknown>,
  req: ChatRequest,
): AsyncIterable<StreamEvent> {
  let finishReason: string | undefined
  try {
    for await (const data of frames) {
      if (req.signal?.aborted) break
      let obj: AnyChunk
      try {
        obj = JSON.parse(data) as AnyChunk
      } catch {
        continue // ignore keep-alive comments / non-JSON frames
      }
      const text = extractDelta(obj)
      if (text) yield { type: 'delta', text }
      const f = extractFinish(obj)
      if (f) finishReason = f
      if (isDoneEvent(obj)) break
    }
  } catch (err) {
    throw normalizeError(err, ID)
  }
  if (req.signal?.aborted) {
    throw new AdapterError('aborted', 'The request was aborted.', { provider: ID })
  }
  yield { type: 'done', reason: finishReason ?? 'stop' }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface AgentBridgeAdapterDeps {
  /** Override `fetch` (tests inject a fake; defaults to the global). */
  fetch?: typeof fetch
}

/** A live Hermes session (created once per adapter instance, then reused). */
interface HermesSession {
  id: string
  key: string
}

/** Construct the agent-bridge `ChatAdapter`. Registered in `lib/providers/index.ts`. */
export function createAgentBridgeAdapter(deps: AgentBridgeAdapterDeps = {}): ChatAdapter {
  const fetchImpl = deps.fetch ?? globalThis.fetch

  // A stable session/thread the running Hermes agent keeps memory against, so we
  // never resend the whole history. Created lazily, then reused across requests.
  let hermesSession: HermesSession | null = null

  /** Turn a fetch failure into a clear "agent offline" error (or preserve abort). */
  function offlineError(base: string, kind: BridgeKind, err: unknown): AdapterError {
    if (isAbort(err)) {
      return new AdapterError('aborted', 'The request was aborted.', { provider: ID, cause: err })
    }
    return new AdapterError(
      'network',
      `The bridged ${kind} agent is offline or unreachable at ${base}.`,
      { provider: ID, cause: err },
    )
  }

  /** POST JSON and return a validated streaming Response (throws typed errors). */
  async function postStreaming(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    kind: BridgeKind,
    base: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      throw offlineError(base, kind, err)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw errorForStatus(res.status, ID, detail.slice(0, 200))
    }
    if (!res.body) {
      throw new AdapterError('upstream_error', `The bridged ${kind} agent returned no body.`, {
        provider: ID,
        status: res.status,
      })
    }
    return res
  }

  function authHeaders(key?: string): Record<string, string> {
    return key ? { Authorization: `Bearer ${key}` } : {}
  }

  /** Ollama: POST /api/chat, NDJSON. Stateless → send full history + system. */
  async function* streamOllama(
    base: string,
    key: string | undefined,
    model: string | undefined,
    req: ChatRequest,
  ): AsyncIterable<StreamEvent> {
    const messages = req.system
      ? [{ role: 'system' as const, content: req.system }, ...req.messages]
      : [...req.messages]
    const body: Record<string, unknown> = {
      model: model || 'llama3.1',
      messages,
      stream: true,
    }
    if (typeof req.temperature === 'number') body.options = { temperature: req.temperature }
    const res = await postStreaming(
      `${base}/api/chat`,
      body,
      authHeaders(key),
      'ollama',
      base,
      req.signal,
    )
    yield* pumpJsonEvents(parseNDJSON(res.body as ReadableStream<Uint8Array>), req)
  }

  /** OpenAI-compatible bridges (openclaw / claude-code / openai-compatible): SSE. */
  async function* streamOpenAICompatible(
    base: string,
    key: string | undefined,
    model: string | undefined,
    kind: BridgeKind,
    req: ChatRequest,
  ): AsyncIterable<StreamEvent> {
    const messages = req.system
      ? [{ role: 'system' as const, content: req.system }, ...req.messages]
      : [...req.messages]
    const body: Record<string, unknown> = {
      model: model || 'default',
      messages,
      max_tokens: MAX_TOKENS,
      stream: true,
    }
    if (typeof req.temperature === 'number') body.temperature = req.temperature
    const res = await postStreaming(
      `${base}/v1/chat/completions`,
      body,
      authHeaders(key),
      kind,
      base,
      req.signal,
    )
    yield* pumpJsonEvents(parseSSEStream(res.body as ReadableStream<Uint8Array>, { provider: ID }), req)
  }

  /** Ensure a Hermes session exists (create once, then reuse the id + key). */
  async function ensureHermesSession(
    base: string,
    key: string | undefined,
    signal?: AbortSignal,
  ): Promise<HermesSession> {
    if (hermesSession) return hermesSession
    let res: Response
    try {
      res = await fetchImpl(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: JSON.stringify({}),
        ...(signal ? { signal } : {}),
      })
    } catch (err) {
      throw offlineError(base, 'hermes', err)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw errorForStatus(res.status, ID, detail.slice(0, 200))
    }
    let json: Record<string, unknown>
    try {
      json = (await res.json()) as Record<string, unknown>
    } catch {
      json = {}
    }
    const id = json.id ?? json.session_id ?? json.sessionId
    const sk = json.key ?? json.session_key ?? json.sessionKey ?? key
    if (id === undefined || id === null || String(id).length === 0) {
      throw new AdapterError('upstream_error', 'Hermes did not return a session id.', {
        provider: ID,
        status: res.status,
      })
    }
    hermesSession = { id: String(id), key: sk ? String(sk) : '' }
    return hermesSession
  }

  /** Hermes: create/reuse a session, send ONLY the latest user turn (stateful). */
  async function* streamHermes(
    base: string,
    key: string | undefined,
    req: ChatRequest,
  ): AsyncIterable<StreamEvent> {
    const session = await ensureHermesSession(base, key, req.signal)
    const body: Record<string, unknown> = {
      message: lastUserContent(req.messages),
      stream: true,
    }
    if (req.system) body.system = req.system
    const headers: Record<string, string> = {
      'X-Hermes-Session-Key': session.key,
      ...authHeaders(key),
    }
    const res = await postStreaming(
      `${base}/api/sessions/${encodeURIComponent(session.id)}/chat`,
      body,
      headers,
      'hermes',
      base,
      req.signal,
    )
    // Hermes may stream as SSE or NDJSON; pick the transport by content-type.
    const ct = res.headers.get('content-type') ?? ''
    const frames = ct.includes('event-stream')
      ? parseSSEStream(res.body as ReadableStream<Uint8Array>, { provider: ID })
      : parseNDJSON(res.body as ReadableStream<Uint8Array>)
    yield* pumpJsonEvents(frames, req)
  }

  return {
    id: ID,
    label: LABEL,
    mode: 'B',

    available(env: ProviderEnv): boolean {
      return bridgeAvailable(env)
    },

    async listModels(env: ProviderEnv = process.env): Promise<ModelInfo[]> {
      const kind = resolveKind(env)
      const configured = resolveModel(env)
      if (kind === 'ollama') {
        const base = resolveBaseUrl(env, kind)
        // Best-effort: fetch the local catalog; never throw from the picker.
        if (base) {
          try {
            const res = await fetchImpl(`${base}/api/tags`, {
              headers: authHeaders(resolveKey(env, kind)),
            })
            if (res.ok) {
              const json = (await res.json()) as { models?: Array<{ name?: string }> }
              const names = (json.models ?? [])
                .map((m) => m.name)
                .filter((n): n is string => typeof n === 'string' && n.length > 0)
              if (names.length > 0) {
                const preferred = configured && names.includes(configured) ? configured : names[0]
                return names.map((id) => ({ id, isDefault: id === preferred }))
              }
            }
          } catch {
            // fall through to the configured-model fallback below
          }
        }
      }
      // Non-Ollama kinds (and any Ollama failure): surface the configured model.
      return configured ? [{ id: configured, isDefault: true }] : []
    },

    async *streamChat(
      req: ChatRequest,
      env: ProviderEnv = process.env,
    ): AsyncIterable<StreamEvent> {
      if (!bridgeAvailable(env)) {
        throw new AdapterError(
          'unavailable',
          'The agent bridge is not configured or not permitted in this environment.',
          { provider: ID },
        )
      }
      const kind = resolveKind(env) as BridgeKind
      const base = resolveBaseUrl(env, kind) as string
      const key = resolveKey(env, kind)
      const model = req.model?.trim() || resolveModel(env)

      if (kind === 'ollama') {
        yield* streamOllama(base, key, model, req)
      } else if (kind === 'hermes') {
        yield* streamHermes(base, key, req)
      } else {
        yield* streamOpenAICompatible(base, key, model, kind, req)
      }
    },
  }
}
