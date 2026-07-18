// Shared SSE parsing for the OpenAI-compatible adapters (OpenRouter, Groq, and
// the openai-compatible agent-bridge kinds). Anthropic ships its own typed SDK
// stream, so it does not need this. This wraps `eventsource-parser` so every
// adapter turns an upstream `text/event-stream` body into the SAME sequence of
// JSON `data:` chunks, with the `[DONE]` sentinel handled in one place.

import { createParser, type EventSourceMessage } from 'eventsource-parser'
import { AdapterError } from '@/lib/providers/types'

/** The `data:` sentinel OpenAI-style streams send to mark end-of-stream. */
export const SSE_DONE = '[DONE]'

/**
 * Parse a raw SSE byte stream into successive `data:` payload strings, dropping
 * the terminal `[DONE]` sentinel. Each yielded string is one event's `data`
 * field — callers `JSON.parse` it into a provider chunk.
 *
 * Backpressure-friendly: reads the fetch body reader and feeds the parser,
 * queueing decoded events and yielding them as the async iterator is pulled.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  options: { provider?: string } = {},
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder()
  const reader = body.getReader()

  // The parser is push-based (callbacks); buffer events between reader pulls.
  const queue: string[] = []
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (event.data === SSE_DONE) return
      queue.push(event.data)
    },
  })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parser.feed(decoder.decode(value, { stream: true }))
      while (queue.length > 0) {
        yield queue.shift() as string
      }
    }
    // Flush any trailing bytes (a final event without a closing newline).
    parser.feed(decoder.decode())
    while (queue.length > 0) {
      yield queue.shift() as string
    }
  } catch (err) {
    if (isAbort(err)) {
      throw new AdapterError('aborted', 'The stream was aborted.', {
        provider: options.provider,
        cause: err,
      })
    }
    throw new AdapterError('upstream_error', 'The provider stream failed.', {
      provider: options.provider,
      cause: err,
    })
  } finally {
    reader.releaseLock()
  }
}

/** True when an error is an AbortController cancellation (barge-in / disconnect). */
export function isAbort(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    err.name === 'AbortError'
  ) ||
    (err instanceof Error && err.name === 'AbortError')
}

/**
 * Map an upstream HTTP status (from a failed fetch to an OpenAI-compatible
 * endpoint) to a typed `AdapterError`. Adapters call this on a non-2xx response
 * so every provider normalizes 401/429/5xx the same way.
 */
export function errorForStatus(
  status: number,
  provider: string,
  detail?: string,
): AdapterError {
  const suffix = detail ? ` ${detail}` : ''
  if (status === 401 || status === 403) {
    return new AdapterError('unauthorized', `${provider} rejected the API key.${suffix}`, {
      provider,
      status,
    })
  }
  if (status === 429) {
    return new AdapterError('rate_limited', `${provider} rate-limited the request.${suffix}`, {
      provider,
      status,
    })
  }
  if (status >= 500) {
    return new AdapterError('upstream_error', `${provider} had an upstream error.${suffix}`, {
      provider,
      status,
    })
  }
  return new AdapterError('bad_request', `${provider} rejected the request.${suffix}`, {
    provider,
    status,
  })
}

/**
 * Convenience: turn any thrown value from a streaming fetch loop into a typed
 * `AdapterError`, preserving an already-typed one. Adapters wrap their
 * `streamChat` body with this so nothing untyped escapes the seam.
 */
export function normalizeError(err: unknown, provider: string): AdapterError {
  if (err instanceof AdapterError) return err
  if (isAbort(err)) {
    return new AdapterError('aborted', 'The request was aborted.', { provider, cause: err })
  }
  if (err instanceof TypeError) {
    // `fetch` throws a TypeError when the endpoint is unreachable.
    return new AdapterError('network', `Could not reach ${provider}.`, { provider, cause: err })
  }
  const message = err instanceof Error ? err.message : String(err)
  return new AdapterError('unknown', `${provider}: ${message}`, { provider, cause: err })
}
