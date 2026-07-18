// Groq chat adapter — Mode A, the fast-inference brain. Groq's LPU serves the
// open Llama family at very low latency (sub-second first token), which makes it
// the go-to when the face should feel snappy. The same GROQ_API_KEY also unlocks
// hosted Whisper STT (whisper-large-v3-turbo) in the /api/transcribe route.
//
// Implements the `ChatAdapter` seam over Groq's OpenAI-compatible endpoint
// https://api.groq.com/openai/v1/chat/completions with `stream: true`, parsing
// the upstream `text/event-stream` through the shared `parseSSEStream` helper and
// honoring `req.signal` so a barge-in cancels the upstream fetch promptly.
//
// `fetch` is injected via `deps` so the adapter is fully unit-testable headlessly
// (tests pass a fake fetch and never touch the network or need a live key).
// Availability is a pure read of `env.GROQ_API_KEY`.

import { errorForStatus, normalizeError, parseSSEStream } from '@/lib/providers/sse'
import {
  AdapterError,
  type ChatAdapter,
  type ChatRequest,
  type ModelInfo,
  type ProviderEnv,
  type StreamEvent,
} from '@/lib/providers/types'

/** Stable registry id + label. */
const ID = 'groq'
const LABEL = 'Groq (fast inference)'

/** Groq's OpenAI-compatible chat endpoint. */
const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions'

/**
 * Output ceiling for one reply — the face SPEAKS its answer, so replies want to
 * be conversational, not essays (mirrors the other Mode A adapters' cap).
 */
const MAX_TOKENS = 4096

/**
 * The hard-coded fallback default when no override is configured. The 70B
 * versatile model balances quality with Groq's headline low latency; the 8B
 * instant model is available for the absolute fastest first token.
 */
const DEFAULT_MODEL = 'llama-3.3-70b-versatile'

/**
 * Curated set of current Groq fast models surfaced to the settings picker. Kept
 * short and current on purpose — the picker is a convenience, and any valid
 * model id can still be passed through `ChatRequest.model`. All are served on
 * Groq's LPU for very-low-latency inference.
 */
const CURATED_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B · versatile' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B · instant (fastest)' },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B' },
]

/** Resolve the preselected model: an explicit override, else the 70B default. */
function defaultModel(env: ProviderEnv): string {
  const override = env.GROQ_DEFAULT_MODEL?.trim()
  return override && override.length > 0 ? override : DEFAULT_MODEL
}

/** One OpenAI-style streaming chunk from `/chat/completions`. */
interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string | null }
    finish_reason?: string | null
  }>
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface GroqAdapterDeps {
  /** Override `fetch` (tests inject a fake; defaults to the global). */
  fetch?: typeof fetch
}

/** Construct the Groq `ChatAdapter`. Registered in `lib/providers/index.ts`. */
export function createGroqAdapter(deps: GroqAdapterDeps = {}): ChatAdapter {
  const fetchImpl = deps.fetch ?? globalThis.fetch

  return {
    id: ID,
    label: LABEL,
    mode: 'A',

    available(env: ProviderEnv): boolean {
      return Boolean(env.GROQ_API_KEY)
    },

    async listModels(env: ProviderEnv = process.env): Promise<ModelInfo[]> {
      const preferred = defaultModel(env)
      const models: ModelInfo[] = CURATED_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        isDefault: m.id === preferred,
      }))
      // Surface an override that isn't in the curated list so the picker can
      // still preselect it.
      if (!models.some((m) => m.id === preferred)) {
        models.unshift({ id: preferred, label: preferred, isDefault: true })
      }
      return models
    },

    async *streamChat(
      req: ChatRequest,
      env: ProviderEnv = process.env,
    ): AsyncIterable<StreamEvent> {
      const apiKey = env.GROQ_API_KEY
      if (!apiKey) {
        throw new AdapterError(
          'unavailable',
          'The Groq brain is not configured (missing GROQ_API_KEY).',
          { provider: ID },
        )
      }

      // Map to the OpenAI chat shape: `system` becomes a leading system message.
      const messages = req.system
        ? [{ role: 'system' as const, content: req.system }, ...req.messages]
        : [...req.messages]

      const body: Record<string, unknown> = {
        model: req.model?.trim() || defaultModel(env),
        max_tokens: MAX_TOKENS,
        stream: true,
        messages,
      }
      // Groq accepts temperature (unlike Anthropic Opus/Sonnet) — forward it.
      if (typeof req.temperature === 'number') body.temperature = req.temperature

      let res: Response
      try {
        res = await fetchImpl(CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          ...(req.signal ? { signal: req.signal } : {}),
        })
      } catch (err) {
        throw normalizeError(err, ID)
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw errorForStatus(res.status, ID, detail.slice(0, 200))
      }
      if (!res.body) {
        throw new AdapterError('upstream_error', 'Groq returned no response body.', {
          provider: ID,
          status: res.status,
        })
      }

      try {
        let finishReason: string | undefined
        for await (const data of parseSSEStream(res.body, { provider: ID })) {
          // Barge-in: stop pumping deltas the instant the client cancels.
          if (req.signal?.aborted) break

          let chunk: OpenAIStreamChunk
          try {
            chunk = JSON.parse(data) as OpenAIStreamChunk
          } catch {
            continue // ignore keep-alive comments / non-JSON frames
          }
          const choice = chunk.choices?.[0]
          const text = choice?.delta?.content
          if (typeof text === 'string' && text.length > 0) {
            yield { type: 'delta', text }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason
        }

        if (req.signal?.aborted) {
          throw new AdapterError('aborted', 'The request was aborted.', { provider: ID })
        }
        yield { type: 'done', reason: finishReason ?? 'stop' }
      } catch (err) {
        throw normalizeError(err, ID)
      }
    },
  }
}
