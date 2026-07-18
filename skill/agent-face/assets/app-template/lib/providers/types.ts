// The provider seam — the ONE contract that covers BOTH brain modes:
//   • Mode A — fresh hosted API (Anthropic, OpenRouter, Groq)
//   • Mode B — an already-running agent bridged in (Hermes, openclaw,
//     claude-code, Ollama, any OpenAI-compatible endpoint)
//
// Adding a provider — or wiring a new running agent — is exactly ONE file that
// implements `ChatAdapter` plus one line in the registry (`lib/providers/index.ts`).
// The `/api/chat` route never learns a provider's name; it only speaks this
// interface. This module is pure types + the typed error class, so it is
// unit-testable headlessly and importable from both server routes and tests.

/** A single chat turn. `system` is carried separately on the request, not here. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Everything an adapter needs to run one streamed completion. */
export interface ChatRequest {
  /** Provider-specific model id. Adapters may fall back to their own default. */
  model?: string
  /** The conversation so far (user/assistant turns only). */
  messages: ChatMessage[]
  /** Optional system prompt / persona. Adapters map this to their own shape. */
  system?: string
  /** Sampling temperature 0..1 (or provider range); adapters may clamp/ignore. */
  temperature?: number
  /**
   * Abort signal for barge-in / client disconnect. Adapters MUST honor this and
   * stop pumping deltas promptly when it fires.
   */
  signal?: AbortSignal
}

/** One model choice an adapter can serve, surfaced to the settings picker. */
export interface ModelInfo {
  id: string
  /** Human-friendly label; defaults to the id when absent. */
  label?: string
  /** True for the adapter's default/preselected model. */
  isDefault?: boolean
}

/**
 * A token/lifecycle event in a streamed completion. The `/api/chat` route
 * serializes these to SSE and the browser chat client parses them back.
 *
 *   • `delta` — an incremental chunk of assistant text.
 *   • `done`  — the stream finished cleanly (optionally with a stop reason).
 *   • `error` — a terminal, already-normalized failure.
 */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; reason?: string }
  | { type: 'error'; error: AdapterErrorShape }

/** The wire-safe shape of an error carried inside a `StreamEvent`. */
export interface AdapterErrorShape {
  /** Machine-readable code the route maps to an HTTP status. */
  code: AdapterErrorCode
  /** Safe, human-readable message (never contains secrets). */
  message: string
  /** Which adapter raised it, when known. */
  provider?: string
  /** Upstream HTTP status, when the failure came from a provider call. */
  status?: number
}

/**
 * The full menu of failure modes any adapter can surface. `/api/chat` maps each
 * to an HTTP status (see {@link statusForAdapterError}).
 */
export type AdapterErrorCode =
  | 'unknown_provider' // no adapter registered under that id
  | 'unavailable' // adapter exists but its key/endpoint is missing or unreachable
  | 'unauthorized' // provider rejected the credential (401/403)
  | 'rate_limited' // provider throttled us (429)
  | 'upstream_error' // provider returned a 5xx / malformed response
  | 'aborted' // the request was cancelled (barge-in / client disconnect)
  | 'bad_request' // our request was malformed / too large (4xx)
  | 'network' // could not reach the provider at all
  | 'unknown' // anything else, normalized

/**
 * The one error type every adapter throws. Concrete adapters normalize whatever
 * their upstream SDK/fetch threw into an `AdapterError` so the route has a single
 * shape to map to a status code — no provider-specific error handling leaks out.
 */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode
  readonly provider?: string
  readonly status?: number

  constructor(
    code: AdapterErrorCode,
    message: string,
    options: { provider?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AdapterError'
    this.code = code
    this.provider = options.provider
    this.status = options.status
    // Restore the prototype chain for `instanceof` under transpiled/ES5 targets.
    Object.setPrototypeOf(this, AdapterError.prototype)
  }

  /** Serialize to the wire-safe shape carried in a `StreamEvent` / route body. */
  toShape(): AdapterErrorShape {
    const shape: AdapterErrorShape = { code: this.code, message: this.message }
    if (this.provider !== undefined) shape.provider = this.provider
    if (this.status !== undefined) shape.status = this.status
    return shape
  }
}

/** Map an adapter error code to the HTTP status `/api/chat` should return. */
export function statusForAdapterError(code: AdapterErrorCode): number {
  switch (code) {
    case 'unknown_provider':
    case 'unavailable':
      return 400
    case 'bad_request':
      return 400
    case 'unauthorized':
      return 401
    case 'rate_limited':
      return 429
    case 'aborted':
      // Client closed the request; there is nobody to send a body to, but 499
      // ("client closed request") is the conventional log status.
      return 499
    case 'upstream_error':
    case 'network':
      return 502
    case 'unknown':
    default:
      return 500
  }
}

/**
 * The pluggable brain seam. Every provider — hosted API or bridged agent —
 * implements exactly this. `env` is passed in (rather than read from
 * `process.env` inside the adapter) so availability is a pure function that
 * tests and `/api/config` can evaluate against any environment snapshot.
 */
export interface ChatAdapter {
  /** Stable registry id, e.g. 'anthropic', 'openrouter', 'groq', 'agent-bridge'. */
  readonly id: string
  /** Human-friendly label for the settings picker. */
  readonly label: string
  /** Which brain mode this adapter belongs to. */
  readonly mode: 'A' | 'B'
  /**
   * True when this adapter's required server keys / reachable endpoint are
   * present in the given environment. MUST be a pure read of `env` (no I/O) so
   * `/api/config` and `listAvailableAdapters` can call it cheaply and often.
   */
  available(env: ProviderEnv): boolean
  /** The models this adapter can serve; the default is flagged `isDefault`. */
  listModels(env?: ProviderEnv): Promise<ModelInfo[]>
  /** Run one streamed completion, yielding `StreamEvent`s until `done`/`error`. */
  streamChat(req: ChatRequest, env?: ProviderEnv): AsyncIterable<StreamEvent>
}

/** Factory signature stored in the registry (adapters are cheap singletons). */
export type ChatAdapterFactory = () => ChatAdapter

/**
 * The environment snapshot availability is evaluated against. `process.env`
 * satisfies this, but so does any plain `{ KEY: value }` object — so `/api/config`
 * and tests can probe availability against an arbitrary env without needing the
 * full `NodeJS.ProcessEnv` shape (which demands `NODE_ENV`).
 */
export type ProviderEnv = Record<string, string | undefined>
