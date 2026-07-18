// The streaming chat route — the ONE HTTP seam the browser talks to for a
// reply, regardless of which brain answers. It picks an adapter by id, streams
// the adapter's `StreamEvent`s to the client as Server-Sent Events, and never
// learns a provider's name beyond that id. All provider secrets live here on
// the server; the route only forwards { provider, model, messages, system }.
//
// Model I/O is wall-clock wait, not billed CPU on Vercel, so we run on the
// Node runtime with a generous maxDuration to allow long completions.

import {
  AdapterError,
  resolveAdapter,
  statusForAdapterError,
  type ChatAdapter,
  type ChatMessage,
  type ChatRequest,
  type StreamEvent,
} from '@/lib/providers'
import { normalizeError } from '@/lib/providers/sse'

export const runtime = 'nodejs'
// Long completions wait on the model, not CPU; give them room (Vercel caps this
// per plan, but declaring it lets self-host / higher tiers stream for minutes).
export const maxDuration = 300

/**
 * Reject bodies approaching Vercel's ~4.5 MB request cap before we buffer or
 * parse them. Chat payloads are tiny (a few turns of text); anything near this
 * is abuse or a bug, so we fail fast with a clear code.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Shape we accept from the client. Everything past `provider` is validated. */
interface ChatRouteBody {
  provider?: unknown
  model?: unknown
  messages?: unknown
  system?: unknown
  temperature?: unknown
}

export async function POST(request: Request): Promise<Response> {
  // 1) Early size guard via Content-Length (cheap; avoids buffering a huge body).
  const declaredLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return errorResponse(
      new AdapterError('bad_request', 'Request body too large.', { status: 413 }),
    )
  }

  // 2) Read + parse the JSON body, still guarding the actual size.
  let parsed: ChatRouteBody
  try {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) {
      return errorResponse(
        new AdapterError('bad_request', 'Request body too large.', { status: 413 }),
      )
    }
    parsed = JSON.parse(text) as ChatRouteBody
  } catch {
    return errorResponse(new AdapterError('bad_request', 'Request body must be valid JSON.'))
  }

  // 3) Validate the required fields.
  const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : ''
  if (!provider) {
    return errorResponse(new AdapterError('bad_request', 'Missing "provider" (brain id).'))
  }
  const messages = normalizeMessages(parsed.messages)
  if (!messages) {
    return errorResponse(
      new AdapterError('bad_request', 'Missing or invalid "messages" array.'),
    )
  }

  // 4) Resolve the adapter. Unknown id or missing key/endpoint -> typed 400.
  let adapter: ChatAdapter
  try {
    adapter = resolveAdapter(provider)
  } catch (err) {
    return errorResponse(err)
  }

  // 5) Build the adapter request, wiring the client's abort signal through so a
  //    disconnect / barge-in stops the upstream token generation promptly.
  const chatRequest: ChatRequest = {
    messages,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    system: typeof parsed.system === 'string' ? parsed.system : undefined,
    temperature: typeof parsed.temperature === 'number' ? parsed.temperature : undefined,
    signal: request.signal,
  }

  // 6) Open the SSE stream. The status line is already 200 by the time we start
  //    pumping, so any mid-stream failure rides the body as an `error` event.
  const body = createEventStream(adapter, chatRequest, provider, request.signal)
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Defeat any intermediary buffering so deltas reach the client as they flush.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

/**
 * Validate/normalize the `messages` field into `ChatMessage[]`, or `null` if it
 * is missing, empty, or malformed. Keeps only `role`/`content`, coercing roles
 * other than 'assistant' to 'user' (a defensive default the adapters expect).
 */
function normalizeMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: ChatMessage[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null
    const { role, content } = raw as { role?: unknown; content?: unknown }
    if (typeof content !== 'string') return null
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content })
  }
  return out
}

/**
 * Pump the adapter's `StreamEvent`s into a `text/event-stream` body, one
 * `data: {json}\n\n` frame per event (flushed immediately for real streaming).
 * A mid-stream failure is normalized to a safe `error` event; a client abort is
 * swallowed (there is nobody left to send to). Always closes the controller.
 */
function createEventStream(
  adapter: ChatAdapter,
  req: ChatRequest,
  provider: string,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }

      try {
        for await (const event of adapter.streamChat(req, process.env)) {
          send(event)
        }
        // Adapters end with their own terminal `done`; nothing more to add.
      } catch (err) {
        const adapterErr = err instanceof AdapterError ? err : normalizeError(err, provider)
        // On a client-side abort the socket is gone — don't try to write an error.
        if (adapterErr.code !== 'aborted' && !signal.aborted) {
          try {
            send({ type: 'error', error: adapterErr.toShape() })
          } catch {
            /* controller may already be closed */
          }
        }
      } finally {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
  })
}

/**
 * Build a JSON error `Response` for failures that happen BEFORE the stream opens
 * (bad body, unknown/unavailable provider). Maps the adapter code to an HTTP
 * status; 499 ("client closed") is not a valid response status here, so clamp it.
 */
function errorResponse(err: unknown): Response {
  const adapterErr = err instanceof AdapterError ? err : new AdapterError('unknown', 'Unexpected error.')
  const status = statusForAdapterError(adapterErr.code)
  return Response.json(
    { error: adapterErr.toShape() },
    { status: status === 499 ? 400 : status },
  )
}
