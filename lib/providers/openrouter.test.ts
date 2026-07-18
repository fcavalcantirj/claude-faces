import { describe, expect, it } from 'vitest'
import { createOpenRouterAdapter } from '@/lib/providers/openrouter'
import { AdapterError, type StreamEvent } from '@/lib/providers/types'

// ---------------------------------------------------------------------------
// Fakes — a stand-in `fetch` so the OpenAI-compatible OpenRouter adapter is
// fully unit-testable headlessly (no live key, no network). We build a real
// ReadableStream body for the streaming endpoint and a JSON body for /models.
// ---------------------------------------------------------------------------

/** Encode an OpenAI-style SSE transcript into a ReadableStream<Uint8Array>. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

/** One `data:` frame carrying a choices delta. */
function deltaFrame(content: string, finish: string | null = null): string {
  const payload = {
    choices: [{ delta: content ? { content } : {}, finish_reason: finish }],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Build a fake fetch that records calls and replies per URL. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  }) as unknown as typeof fetch
  return { fn, calls }
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const ENV = { OPENROUTER_API_KEY: 'sk-or-test' }

describe('openrouter adapter — availability & models', () => {
  it('is available only when OPENROUTER_API_KEY is present', () => {
    const adapter = createOpenRouterAdapter()
    expect(adapter.available(ENV)).toBe(true)
    expect(adapter.available({})).toBe(false)
    expect(adapter.id).toBe('openrouter')
    expect(adapter.mode).toBe('A')
  })

  it('lists at least one Nous Hermes model, favorites first', async () => {
    const { fn } = fakeFetch(() =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' },
            { id: 'meta-llama/llama-3.1-8b-instruct', name: 'Llama 3.1 8B' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const adapter = createOpenRouterAdapter({ fetch: fn })
    const models = await adapter.listModels(ENV)
    const ids = models.map((m) => m.id)
    expect(ids.some((id) => id.includes('hermes'))).toBe(true)
    // Favorites (Hermes) are surfaced ahead of the fetched catalog.
    expect(ids[0].includes('hermes')).toBe(true)
    // Fetched catalog models are merged in too.
    expect(ids).toContain('openai/gpt-4o-mini')
  })

  it('honors OPENROUTER_DEFAULT_MODEL as the default override', async () => {
    const { fn } = fakeFetch(() =>
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    )
    const adapter = createOpenRouterAdapter({ fetch: fn })
    const models = await adapter.listModels({
      ...ENV,
      OPENROUTER_DEFAULT_MODEL: 'openai/gpt-4o',
    })
    const def = models.find((m) => m.isDefault)
    expect(def?.id).toBe('openai/gpt-4o')
  })

  it('degrades to the Hermes favorites when the catalog fetch fails', async () => {
    const { fn } = fakeFetch(() => new Response('nope', { status: 500 }))
    const adapter = createOpenRouterAdapter({ fetch: fn })
    const models = await adapter.listModels(ENV)
    expect(models.some((m) => m.id.includes('hermes'))).toBe(true)
  })
})

describe('openrouter adapter — streaming', () => {
  it('yields incremental deltas then a done event', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url).toContain('/chat/completions')
      return new Response(
        sseStream([
          deltaFrame('Hel'),
          deltaFrame('lo '),
          deltaFrame('world', 'stop'),
          'data: [DONE]\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const adapter = createOpenRouterAdapter({ fetch: fn })
    const events = await collect(
      adapter.streamChat({ messages: [{ role: 'user', content: 'hi' }] }, ENV),
    )
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo ' },
      { type: 'delta', text: 'world' },
      { type: 'done', reason: 'stop' },
    ])
    // Bearer key + OpenRouter etiquette headers are set.
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-or-test')
    expect(headers['HTTP-Referer']).toBeTruthy()
    expect(headers['X-Title']).toBeTruthy()
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.stream).toBe(true)
  })

  it('maps the system prompt into the messages array as a system role', async () => {
    const { fn, calls } = fakeFetch(() =>
      new Response(sseStream([deltaFrame('ok', 'stop'), 'data: [DONE]\n\n']), { status: 200 }),
    )
    const adapter = createOpenRouterAdapter({ fetch: fn })
    await collect(
      adapter.streamChat(
        {
          model: 'nousresearch/hermes-3-llama-3.1-70b',
          system: 'You are a face.',
          messages: [{ role: 'user', content: 'a' }],
        },
        ENV,
      ),
    )
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.model).toBe('nousresearch/hermes-3-llama-3.1-70b')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a face.' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'a' })
  })

  it('throws unavailable when no API key is present', async () => {
    const adapter = createOpenRouterAdapter()
    await expect(
      collect(adapter.streamChat({ messages: [{ role: 'user', content: 'x' }] }, {})),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('surfaces a 401 from a bad key as a typed unauthorized AdapterError', async () => {
    const { fn } = fakeFetch(() => new Response('bad key', { status: 401 }))
    const adapter = createOpenRouterAdapter({ fetch: fn })
    let caught: unknown
    try {
      await collect(adapter.streamChat({ messages: [{ role: 'user', content: 'x' }] }, ENV))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AdapterError)
    expect((caught as AdapterError).code).toBe('unauthorized')
    expect((caught as AdapterError).status).toBe(401)
  })

  it('stops emitting deltas once the signal is aborted (barge-in)', async () => {
    const controller = new AbortController()
    const { fn } = fakeFetch(() =>
      new Response(
        sseStream([deltaFrame('one'), deltaFrame('two'), deltaFrame('three', 'stop'), 'data: [DONE]\n\n']),
        { status: 200 },
      ),
    )
    const adapter = createOpenRouterAdapter({ fetch: fn })
    const received: StreamEvent[] = []
    let caught: unknown
    try {
      for await (const ev of adapter.streamChat(
        { messages: [{ role: 'user', content: 'go' }], signal: controller.signal },
        ENV,
      )) {
        received.push(ev)
        if (ev.type === 'delta' && ev.text === 'one') controller.abort()
      }
    } catch (err) {
      caught = err
    }
    expect(received).toEqual([{ type: 'delta', text: 'one' }])
    expect(caught).toBeInstanceOf(AdapterError)
    expect((caught as AdapterError).code).toBe('aborted')
  })
})
