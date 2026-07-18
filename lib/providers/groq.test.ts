import { describe, expect, it } from 'vitest'
import { createGroqAdapter } from '@/lib/providers/groq'
import { AdapterError, type StreamEvent } from '@/lib/providers/types'

// ---------------------------------------------------------------------------
// Fakes — a stand-in `fetch` so the OpenAI-compatible Groq adapter is fully
// unit-testable headlessly (no live key, no network). We build a real
// ReadableStream body for the streaming `/chat/completions` endpoint.
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

const ENV = { GROQ_API_KEY: 'gsk-test' }

describe('groq adapter — availability & models', () => {
  it('is available only when GROQ_API_KEY is present', () => {
    const adapter = createGroqAdapter()
    expect(adapter.available(ENV)).toBe(true)
    expect(adapter.available({})).toBe(false)
    expect(adapter.id).toBe('groq')
    expect(adapter.mode).toBe('A')
  })

  it('lists Groq fast models with a Llama family member and a marked default', async () => {
    const adapter = createGroqAdapter()
    const models = await adapter.listModels(ENV)
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id.toLowerCase().includes('llama'))).toBe(true)
    expect(models.filter((m) => m.isDefault).length).toBe(1)
  })

  it('honors GROQ_DEFAULT_MODEL as the default override', async () => {
    const adapter = createGroqAdapter()
    const models = await adapter.listModels({
      ...ENV,
      GROQ_DEFAULT_MODEL: 'some-custom/model',
    })
    const def = models.find((m) => m.isDefault)
    expect(def?.id).toBe('some-custom/model')
    // An override outside the curated list is still surfaced in the picker.
    expect(models.some((m) => m.id === 'some-custom/model')).toBe(true)
  })
})

describe('groq adapter — streaming', () => {
  it('yields incremental deltas then a done event', async () => {
    const { fn, calls } = fakeFetch((url) => {
      expect(url).toContain('/openai/v1/chat/completions')
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
    const adapter = createGroqAdapter({ fetch: fn })
    const events = await collect(
      adapter.streamChat({ messages: [{ role: 'user', content: 'hi' }] }, ENV),
    )
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo ' },
      { type: 'delta', text: 'world' },
      { type: 'done', reason: 'stop' },
    ])
    // Bearer key is set and stream:true is requested.
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer gsk-test')
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.stream).toBe(true)
  })

  it('maps the system prompt into the messages array as a system role', async () => {
    const { fn, calls } = fakeFetch(() =>
      new Response(sseStream([deltaFrame('ok', 'stop'), 'data: [DONE]\n\n']), { status: 200 }),
    )
    const adapter = createGroqAdapter({ fetch: fn })
    await collect(
      adapter.streamChat(
        {
          model: 'llama-3.1-8b-instant',
          system: 'You are a face.',
          messages: [{ role: 'user', content: 'a' }],
        },
        ENV,
      ),
    )
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.model).toBe('llama-3.1-8b-instant')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a face.' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'a' })
  })

  it('throws unavailable when no API key is present', async () => {
    const adapter = createGroqAdapter()
    await expect(
      collect(adapter.streamChat({ messages: [{ role: 'user', content: 'x' }] }, {})),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('surfaces a 401 from a bad key as a typed unauthorized AdapterError', async () => {
    const { fn } = fakeFetch(() => new Response('bad key', { status: 401 }))
    const adapter = createGroqAdapter({ fetch: fn })
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
    const adapter = createGroqAdapter({ fetch: fn })
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
