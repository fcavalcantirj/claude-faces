// Anthropic (Claude) chat adapter — Mode A, the highest-priority hosted brain.
//
// Implements the `ChatAdapter` seam over the Anthropic Messages API with
// `stream: true`, translating `content_block_delta` text into the app's
// `StreamEvent` deltas and honoring `req.signal` so a barge-in (user starts
// talking over the face) cancels the upstream stream promptly.
//
// The SDK client is created behind an injectable `createClient` seam so the
// adapter is fully unit-testable headlessly — tests pass a fake client and
// never touch the network or need a live key. Availability is a pure read of
// `env.ANTHROPIC_API_KEY`, so `/api/config` can probe it without any I/O.

import { errorForStatus, isAbort, normalizeError } from '@/lib/providers/sse'
import {
  AdapterError,
  type ChatAdapter,
  type ChatRequest,
  type ModelInfo,
  type ProviderEnv,
  type StreamEvent,
} from '@/lib/providers/types'

/** Stable registry id + label. */
const ID = 'anthropic'
const LABEL = 'Anthropic (Claude)'

/**
 * Output ceiling for one reply. The face SPEAKS its answer, so replies want to
 * be conversational, not essays — 4096 tokens is ample headroom without
 * inviting rambling, and stays well under any streaming HTTP timeout.
 */
const MAX_TOKENS = 4096

/** The hard-coded fallback default when no override is configured. */
const DEFAULT_MODEL = 'claude-opus-4-8'

/**
 * Curated set of current `claude-*` models surfaced to the settings picker.
 * The default is `claude-opus-4-8` unless `ANTHROPIC_DEFAULT_MODEL` overrides
 * it. Kept short and current on purpose — the picker is a convenience, and any
 * valid model id can still be passed through `ChatRequest.model`.
 */
const CURATED_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
]

/** Resolve the preselected model: an explicit override, else `claude-opus-4-8`. */
function defaultModel(env: ProviderEnv): string {
  const override = env.ANTHROPIC_DEFAULT_MODEL?.trim()
  return override && override.length > 0 ? override : DEFAULT_MODEL
}

// ---------------------------------------------------------------------------
// Minimal client surface + injection seam
// ---------------------------------------------------------------------------

/** The slice of a raw Anthropic stream event the adapter reads. */
interface AnthropicStreamEvent {
  type: string
  delta?: {
    type?: string
    text?: string
    stop_reason?: string | null
  }
}

/** The tiny slice of the Anthropic SDK client the adapter depends on. */
export interface AnthropicClientLike {
  messages: {
    stream(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<AnthropicStreamEvent>
  }
}

/** Factory that builds a client from a server-side API key (may be async). */
export type CreateAnthropicClient = (
  apiKey: string,
) => AnthropicClientLike | Promise<AnthropicClientLike>

/**
 * Real client factory: lazily imports the SDK so the module stays light and no
 * browser-environment guard trips at import time (the SDK constructor is only
 * reached server-side, with a key present).
 */
const defaultCreateClient: CreateAnthropicClient = async (apiKey) => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  return new Anthropic({ apiKey }) as unknown as AnthropicClientLike
}

/** Normalize whatever the SDK/stream threw into a typed `AdapterError`. */
function normalizeAnthropicError(err: unknown): AdapterError {
  if (err instanceof AdapterError) return err
  if (isAbort(err)) {
    return new AdapterError('aborted', 'The request was aborted.', { provider: ID, cause: err })
  }
  // Anthropic SDK errors carry a numeric HTTP `status`; map it to a typed code.
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status: unknown }).status)
    if (Number.isFinite(status)) {
      const message = err instanceof Error ? err.message : String(err)
      return errorForStatus(status, ID, message)
    }
  }
  return normalizeError(err, ID)
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface AnthropicAdapterDeps {
  /** Override the SDK client factory (tests inject a fake). */
  createClient?: CreateAnthropicClient
}

/** Construct the Anthropic `ChatAdapter`. Registered in `lib/providers/index.ts`. */
export function createAnthropicAdapter(deps: AnthropicAdapterDeps = {}): ChatAdapter {
  const createClient = deps.createClient ?? defaultCreateClient

  return {
    id: ID,
    label: LABEL,
    mode: 'A',

    available(env: ProviderEnv): boolean {
      return Boolean(env.ANTHROPIC_API_KEY)
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
      const apiKey = env.ANTHROPIC_API_KEY
      if (!apiKey) {
        throw new AdapterError(
          'unavailable',
          'The Anthropic brain is not configured (missing ANTHROPIC_API_KEY).',
          { provider: ID },
        )
      }

      // Build the request body. `system` maps to the top-level param; the
      // user/assistant turns map straight to content blocks. `temperature` is
      // intentionally NOT forwarded — it is rejected (400) on Opus 4.8 / 4.7 /
      // Sonnet 5, the models this adapter defaults to; steer via prompting.
      const body: Record<string, unknown> = {
        model: req.model?.trim() || defaultModel(env),
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      }
      if (req.system) body.system = req.system

      try {
        const client = await createClient(apiKey)
        const stream = client.messages.stream(
          body,
          req.signal ? { signal: req.signal } : undefined,
        )

        let stopReason: string | undefined
        for await (const event of stream) {
          // Barge-in: stop pumping deltas the instant the client cancels.
          if (req.signal?.aborted) break

          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta' &&
            typeof event.delta.text === 'string'
          ) {
            yield { type: 'delta', text: event.delta.text }
          } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason
          }
        }

        if (req.signal?.aborted) {
          throw new AdapterError('aborted', 'The request was aborted.', { provider: ID })
        }
        yield { type: 'done', reason: stopReason ?? 'end_turn' }
      } catch (err) {
        throw normalizeAnthropicError(err)
      }
    },
  }
}
