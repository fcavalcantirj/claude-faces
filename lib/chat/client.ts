// The browser streaming chat client — the ONE seam the UI calls to talk to a
// brain. It POSTs to `/api/chat`, parses the Server-Sent Events the route emits
// (`data: {json StreamEvent}\n\n`), and turns them back into token deltas.
//
// Two layers:
//   • `streamChat(opts)` — a pure async generator that yields delta strings and
//     returns the stop reason. Throws a typed `AdapterError` on a stream error
//     event or a non-ok response. Use it directly to render tokens progressively.
//   • `runChat(opts, callbacks)` — the driver the orchestrator uses. It layers
//     the conversation lifecycle on top: fires onStart → 'thinking',
//     onFirstToken → the 'speaking' handoff, buffers deltas into sentence-sized
//     chunks and hands each (directive-stripped) to TTS the moment it completes
//     so speech starts before the reply finishes, and exposes an AbortController
//     for barge-in that stops token accumulation AND queued TTS.
//
// Both are headlessly testable: `fetchImpl` is injectable, so a fake `fetch`
// returning a `ReadableStream` of SSE frames drives the whole thing with no
// network or browser.

import { parseSSEStream, errorForStatus, normalizeError } from '@/lib/providers/sse'
import { AdapterError, type ChatMessage, type StreamEvent } from '@/lib/providers'
import {
  parseFaceDirective,
  restingEmotionForReply,
} from '@/lib/face/emotion-machine'
import { type Emotion } from '@/lib/face-points'

/** Options for the low-level `streamChat` generator. */
export interface StreamChatOptions {
  /** Registry id of the brain to answer (e.g. 'anthropic', 'groq'). */
  provider: string
  /** Provider-specific model id; the server falls back to the adapter default. */
  model?: string
  /** The conversation so far (user/assistant turns only). */
  messages: ChatMessage[]
  /** Optional system prompt / persona. */
  system?: string
  /** Sampling temperature; adapters may clamp/ignore. */
  temperature?: number
  /** Abort signal for barge-in / client cancel. */
  signal?: AbortSignal
  /** The route to POST to. Defaults to '/api/chat'. */
  endpoint?: string
  /** Injectable `fetch` (tests / non-browser hosts). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

/** The generator's return value when the stream ends cleanly. */
export interface StreamDone {
  /** The upstream stop reason, when the provider reported one. */
  reason?: string
}

const DEFAULT_ENDPOINT = '/api/chat'

function resolveFetch(custom?: typeof fetch): typeof fetch {
  if (custom) return custom
  if (typeof fetch !== 'undefined') return fetch.bind(globalThis)
  throw new AdapterError('network', 'No fetch implementation is available.')
}

/**
 * POST to `/api/chat` and yield each assistant text delta as it streams back,
 * returning the stop reason when the stream ends. Throws a typed `AdapterError`
 * on a non-ok response (before the stream opens) or an in-stream `error` event.
 */
export async function* streamChat(
  opts: StreamChatOptions,
): AsyncGenerator<string, StreamDone, void> {
  const { provider, model, messages, system, temperature, signal } = opts
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
  const doFetch = resolveFetch(opts.fetchImpl)

  if (signal?.aborted) {
    throw new AdapterError('aborted', 'The request was aborted before it began.', { provider })
  }

  let res: Response
  try {
    res = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, messages, system, temperature }),
      signal,
    })
  } catch (err) {
    // A thrown fetch is an abort or an unreachable endpoint.
    throw normalizeError(err, provider)
  }

  if (!res.ok) {
    throw await errorFromResponse(res, provider)
  }
  if (!res.body) {
    throw new AdapterError('network', 'The chat response had no body.', { provider })
  }

  let reason: string | undefined
  for await (const data of parseSSEStream(res.body, { provider })) {
    if (signal?.aborted) {
      throw new AdapterError('aborted', 'The stream was aborted.', { provider })
    }
    if (!data) continue
    let event: StreamEvent
    try {
      event = JSON.parse(data) as StreamEvent
    } catch {
      // Defensive: ignore a frame that isn't valid JSON (keep-alive, etc.).
      continue
    }
    if (event.type === 'delta') {
      if (event.text) yield event.text
    } else if (event.type === 'done') {
      reason = event.reason
      return { reason }
    } else if (event.type === 'error') {
      const e = event.error
      throw new AdapterError(e.code, e.message, {
        provider: e.provider ?? provider,
        status: e.status,
      })
    }
  }
  return { reason }
}

/** Turn a non-ok `Response` into a typed `AdapterError`, preferring its JSON body. */
export async function errorFromResponse(res: Response, provider: string): Promise<AdapterError> {
  let shape: unknown
  try {
    const body = (await res.json()) as { error?: unknown }
    shape = body?.error
  } catch {
    /* non-JSON body — fall back to the status code */
  }
  if (shape && typeof shape === 'object') {
    const s = shape as { code?: string; message?: string; provider?: string; status?: number }
    if (typeof s.code === 'string') {
      return new AdapterError(s.code as AdapterError['code'], s.message ?? 'The request failed.', {
        provider: s.provider ?? provider,
        status: s.status ?? res.status,
      })
    }
  }
  return errorForStatus(res.status, provider)
}

// --- sentence chunking ------------------------------------------------------

/**
 * Split a growing text buffer into COMPLETE sentences plus a trailing `rest`.
 *
 * A sentence boundary is a run of `.` / `!` / `?` (with any closing quote/paren)
 * that is FOLLOWED BY whitespace — so a terminator at the very end of the buffer
 * is left in `rest` (more tokens may continue it, e.g. a decimal `3.` mid-stream).
 * A newline is always a boundary. Returned sentences are trimmed and non-empty.
 */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = []
  let start = 0
  let i = 0
  const push = (end: number) => {
    const seg = text.slice(start, end).trim()
    if (seg) sentences.push(seg)
  }
  while (i < text.length) {
    const ch = text[i]
    if (ch === '.' || ch === '!' || ch === '?') {
      // Extend over consecutive terminators, then any closing quotes/brackets.
      let j = i
      while (j + 1 < text.length && '.!?'.includes(text[j + 1])) j++
      while (j + 1 < text.length && '"\')]'.includes(text[j + 1])) j++
      const after = text[j + 1]
      if (after !== undefined && /\s/.test(after)) {
        push(j + 1)
        // Skip the whitespace between sentences so `rest` has no leading space.
        let k = j + 1
        while (k < text.length && /\s/.test(text[k])) k++
        start = k
        i = k
        continue
      }
      i = j + 1
      continue
    }
    if (ch === '\n') {
      push(i)
      start = i + 1
    }
    i++
  }
  return { sentences, rest: text.slice(start) }
}

// --- runChat (driver) -------------------------------------------------------

/** Options for the `runChat` driver — `signal` is an OPTIONAL external abort. */
export interface RunChatOptions {
  provider: string
  model?: string
  messages: ChatMessage[]
  system?: string
  temperature?: number
  endpoint?: string
  fetchImpl?: typeof fetch
  /** An external signal to also abort on (in addition to the internal one). */
  signal?: AbortSignal
}

/** Lifecycle callbacks the orchestrator wires to emotion + TTS. */
export interface ChatDriverCallbacks {
  /** Stream opened — orchestrator sets emotion 'thinking'. */
  onStart?: () => void
  /** First delta arrived — begin the 'speaking' handoff to TTS. */
  onFirstToken?: () => void
  /** Each delta: `(delta, accumulatedRaw)` — render the transcript progressively. */
  onToken?: (delta: string, accumulated: string) => void
  /** A complete, directive-stripped sentence ready for incremental TTS. */
  onSentence?: (sentence: string) => void
  /** Clean completion with the final result (spoken text + resting emotion). */
  onDone?: (result: ChatResult) => void
  /** A terminal error (NOT a barge-in) — orchestrator sets emotion 'glitch'. */
  onError?: (error: AdapterError) => void
}

/** The outcome of one chat turn. */
export interface ChatResult {
  /** The full assistant text as streamed (directives included). */
  raw: string
  /** The spoken text: directives stripped (what TTS should say). */
  text: string
  /** The resting emotion resolved from the reply (directive or sentiment). */
  emotion: Emotion
  /** The upstream stop reason, when reported. */
  reason?: string
  /** True when the turn was cancelled (barge-in / external abort). */
  aborted: boolean
  /** Set when the turn ended on a terminal error (not an abort). */
  error?: AdapterError
}

/** A running chat turn the UI can observe and cancel. */
export interface ChatSession {
  /** The internal AbortController driving the request (exposed for the UI). */
  controller: AbortController
  /** Barge-in: abort the in-flight request, stopping tokens AND queued TTS. */
  abort(): void
  /** Resolves once the turn ends (clean, aborted, or errored). Never rejects. */
  done: Promise<ChatResult>
}

/**
 * Drive one chat turn: stream tokens, render them progressively, chunk them into
 * sentences for incremental TTS, resolve the resting emotion, and expose barge-in.
 */
export function runChat(
  opts: RunChatOptions,
  callbacks: ChatDriverCallbacks = {},
): ChatSession {
  const controller = new AbortController()
  const external = opts.signal
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let resolveDone!: (r: ChatResult) => void
  const done = new Promise<ChatResult>((resolve) => {
    resolveDone = resolve
  })
  let settled = false

  let raw = ''
  let buffer = ''
  let firstToken = false

  const settle = (partial: Partial<ChatResult>): ChatResult => {
    const { emotion, text } = restingEmotionForReply(raw)
    const result: ChatResult = {
      raw,
      text: partial.text ?? text,
      emotion: partial.emotion ?? emotion,
      reason: partial.reason,
      aborted: partial.aborted ?? false,
      error: partial.error,
    }
    if (!settled) {
      settled = true
      resolveDone(result)
    }
    return result
  }

  callbacks.onStart?.()

  void (async () => {
    let reason: string | undefined
    const iterator = streamChat({
      provider: opts.provider,
      model: opts.model,
      messages: opts.messages,
      system: opts.system,
      temperature: opts.temperature,
      endpoint: opts.endpoint,
      fetchImpl: opts.fetchImpl,
      signal: controller.signal,
    })

    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done) {
          reason = next.value?.reason
          break
        }
        if (controller.signal.aborted) break
        const deltaText = next.value

        if (!firstToken) {
          firstToken = true
          callbacks.onFirstToken?.()
        }
        raw += deltaText
        callbacks.onToken?.(deltaText, raw)

        buffer += deltaText
        const { sentences, rest } = splitSentences(buffer)
        buffer = rest
        for (const sentence of sentences) {
          if (controller.signal.aborted) break
          const { text } = parseFaceDirective(sentence)
          if (text) callbacks.onSentence?.(text)
        }
      }
    } catch (err) {
      const adapterErr = err instanceof AdapterError ? err : normalizeError(err, opts.provider)
      // A barge-in is not an error: swallow it and settle as aborted.
      if (adapterErr.code === 'aborted' || controller.signal.aborted) {
        settle({ aborted: true })
      } else {
        callbacks.onError?.(adapterErr)
        settle({ error: adapterErr })
      }
      return
    }

    // Broke out because of barge-in — stop; do NOT flush the queued tail to TTS.
    if (controller.signal.aborted) {
      void iterator.return?.(undefined as unknown as StreamDone).catch(() => {})
      settle({ aborted: true })
      return
    }

    // Clean completion: flush the remaining buffered tail (directive-stripped).
    const tail = buffer.trim()
    if (tail) {
      const { text } = parseFaceDirective(tail)
      if (text) callbacks.onSentence?.(text)
    }
    buffer = ''

    const result = settle({ reason })
    callbacks.onDone?.(result)
  })()

  return {
    controller,
    abort: () => controller.abort(),
    done,
  }
}
