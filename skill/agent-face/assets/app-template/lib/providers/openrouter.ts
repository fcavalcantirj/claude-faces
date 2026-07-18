// OpenRouter chat adapter — Mode A. One key unlocks hundreds of models behind a
// single OpenAI-compatible endpoint, INCLUDING Nous Research's Hermes line, so
// this adapter doubles as the "Hermes over a fresh API" brain.
//
// Implements the `ChatAdapter` seam over
// https://openrouter.ai/api/v1/chat/completions with `stream: true`, parsing the
// upstream `text/event-stream` through the shared `parseSSEStream` helper and
// honoring `req.signal` so a barge-in cancels the upstream fetch promptly.
//
// `fetch` is injected via `deps` so the adapter is fully unit-testable headlessly
// (tests pass a fake fetch and never touch the network or need a live key).
// Availability is a pure read of `env.OPENROUTER_API_KEY`.

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
const ID = 'openrouter'
const LABEL = 'OpenRouter (Hermes + hundreds)'

/** OpenAI-compatible endpoints on the OpenRouter API. */
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODELS_URL = 'https://openrouter.ai/api/v1/models'

/**
 * OpenRouter etiquette: `HTTP-Referer` + `X-Title` identify the calling app on
 * the OpenRouter dashboard/leaderboards. Non-secret and safe to hard-code.
 */
const APP_REFERER = 'https://github.com/fcavalcantirj/claude-faces'
const APP_TITLE = 'Claude Faces'

/**
 * Output ceiling for one reply — the face SPEAKS its answer, so replies want to
 * be conversational, not essays (mirrors the Anthropic adapter's cap).
 */
const MAX_TOKENS = 4096

/** The hard-coded fallback default when no override is configured. */
const DEFAULT_MODEL = 'nousresearch/hermes-3-llama-3.1-70b'

/**
 * Pinned Nous Research Hermes ids surfaced as favorites at the top of the picker
 * (OpenRouter's headline draw for this project). The live catalog from `/models`
 * is merged in after these.
 */
const HERMES_FAVORITES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'nousresearch/hermes-3-llama-3.1-405b', label: 'Nous Hermes 3 · Llama 3.1 405B' },
  { id: 'nousresearch/hermes-3-llama-3.1-70b', label: 'Nous Hermes 3 · Llama 3.1 70B' },
  { id: 'nousresearch/hermes-2-pro-llama-3-8b', label: 'Nous Hermes 2 Pro · Llama 3 8B' },
]

/** How long a fetched `/models` catalog stays fresh before we re-fetch. */
const CATALOG_TTL_MS = 5 * 60_000

/** Resolve the preselected model: an explicit override, else the Hermes default. */
function defaultModel(env: ProviderEnv): string {
  const override = env.OPENROUTER_DEFAULT_MODEL?.trim()
  return override && override.length > 0 ? override : DEFAULT_MODEL
}

/** The tiny slice of an OpenRouter `/models` entry we read. */
interface OpenRouterModelEntry {
  id?: string
  name?: string
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

export interface OpenRouterAdapterDeps {
  /** Override `fetch` (tests inject a fake; defaults to the global). */
  fetch?: typeof fetch
}

/** Construct the OpenRouter `ChatAdapter`. Registered in `lib/providers/index.ts`. */
export function createOpenRouterAdapter(deps: OpenRouterAdapterDeps = {}): ChatAdapter {
  const fetchImpl = deps.fetch ?? globalThis.fetch

  // Per-adapter (not module-global) cache of the raw catalog so tests stay
  // isolated — each `createOpenRouterAdapter()` starts with an empty cache.
  let catalogCache: { at: number; entries: Array<{ id: string; label: string }> } | null = null

  /** Fetch the live model catalog, degrading to `[]` on any failure. */
  async function fetchCatalog(env: ProviderEnv): Promise<Array<{ id: string; label: string }>> {
    const now = Date.now()
    if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.entries
    try {
      const headers: Record<string, string> = {
        'HTTP-Referer': APP_REFERER,
        'X-Title': APP_TITLE,
      }
      // The catalog is public, but send the key when present for higher limits.
      if (env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${env.OPENROUTER_API_KEY}`
      const res = await fetchImpl(MODELS_URL, { headers })
      if (!res.ok) return []
      const json = (await res.json()) as { data?: OpenRouterModelEntry[] }
      const entries = (json.data ?? [])
        .filter((m): m is { id: string; name?: string } => typeof m.id === 'string')
        .map((m) => ({ id: m.id, label: m.name?.trim() || m.id }))
      catalogCache = { at: now, entries }
      return entries
    } catch {
      // The picker must never break on a catalog hiccup — fall back to favorites.
      return []
    }
  }

  return {
    id: ID,
    label: LABEL,
    mode: 'A',

    available(env: ProviderEnv): boolean {
      return Boolean(env.OPENROUTER_API_KEY)
    },

    async listModels(env: ProviderEnv = process.env): Promise<ModelInfo[]> {
      const preferred = defaultModel(env)
      const catalog = await fetchCatalog(env)

      // Favorites first, then the live catalog with duplicates removed.
      const ordered: Array<{ id: string; label: string }> = [...HERMES_FAVORITES]
      const seen = new Set(ordered.map((m) => m.id))
      for (const m of catalog) {
        if (!seen.has(m.id)) {
          ordered.push(m)
          seen.add(m.id)
        }
      }
      // Surface an override that is in neither list so the picker can preselect it.
      if (!seen.has(preferred)) {
        ordered.unshift({ id: preferred, label: preferred })
        seen.add(preferred)
      }

      return ordered.map((m) => ({ id: m.id, label: m.label, isDefault: m.id === preferred }))
    },

    async *streamChat(
      req: ChatRequest,
      env: ProviderEnv = process.env,
    ): AsyncIterable<StreamEvent> {
      const apiKey = env.OPENROUTER_API_KEY
      if (!apiKey) {
        throw new AdapterError(
          'unavailable',
          'The OpenRouter brain is not configured (missing OPENROUTER_API_KEY).',
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
      // OpenRouter (unlike Anthropic Opus/Sonnet) accepts temperature — forward it.
      if (typeof req.temperature === 'number') body.temperature = req.temperature

      let res: Response
      try {
        res = await fetchImpl(CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': APP_REFERER,
            'X-Title': APP_TITLE,
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
        throw new AdapterError('upstream_error', 'OpenRouter returned no response body.', {
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
