import { describe, expect, it } from 'vitest'
import { createAnthropicAdapter } from '@/lib/providers/anthropic'
import { AdapterError, type StreamEvent } from '@/lib/providers/types'

// ---------------------------------------------------------------------------
// Fakes — a stand-in for the Anthropic SDK client so the adapter is fully
// unit-testable headlessly (no live key, no network). We only implement the
// tiny slice of the client the adapter touches: `messages.stream(body, opts)`.
// ---------------------------------------------------------------------------

/** One raw Anthropic stream event, in the shape the adapter reads. */
type RawEvent =
  | { type: 'content_block_delta'; delta: { type: 'text_delta'; text: string } }
  | { type: 'content_block_delta'; delta: { type: 'thinking_delta'; thinking: string } }
  | { type: 'message_delta'; delta: { stop_reason: string | null } }
  | { type: 'message_stop' }

/** Build a fake client whose stream replays `events`, recording the body it got. */
function fakeClient(events: RawEvent[]) {
  const calls: { body: any; options: any }[] = []
  return {
    calls,
    client: {
      messages: {
        stream(body: unknown, options?: { signal?: AbortSignal }) {
          calls.push({ body, options })
          return (async function* () {
            for (const ev of events) yield ev
          })()
        },
      },
    },
  }
}

/** Drain an async iterable of StreamEvents into an array. */
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const ENV = { ANTHROPIC_API_KEY: 'sk-ant-test' }

describe('anthropic adapter — availability & models', () => {
  it('is available only when ANTHROPIC_API_KEY is present', () => {
    const adapter = createAnthropicAdapter()
    expect(adapter.available(ENV)).toBe(true)
    expect(adapter.available({})).toBe(false)
    expect(adapter.id).toBe('anthropic')
    expect(adapter.mode).toBe('A')
  })

  it('lists curated claude-* models with claude-opus-4-8 as the default', async () => {
    const adapter = createAnthropicAdapter()
    const models = await adapter.listModels(ENV)
    const ids = models.map((m) => m.id)
    expect(ids).toContain('claude-opus-4-8')
    expect(ids.every((id) => id.startsWith('claude-'))).toBe(true)
    const def = models.find((m) => m.isDefault)
    expect(def?.id).toBe('claude-opus-4-8')
  })

  it('honors ANTHROPIC_DEFAULT_MODEL as the default override', async () => {
    const adapter = createAnthropicAdapter()
    const models = await adapter.listModels({
      ...ENV,
      ANTHROPIC_DEFAULT_MODEL: 'claude-haiku-4-5',
    })
    const def = models.find((m) => m.isDefault)
    expect(def?.id).toBe('claude-haiku-4-5')
    // The override is surfaced even if it is not in the curated list.
    const models2 = await adapter.listModels({ ...ENV, ANTHROPIC_DEFAULT_MODEL: 'claude-custom-x' })
    expect(models2.find((m) => m.isDefault)?.id).toBe('claude-custom-x')
  })
})

describe('anthropic adapter — streaming', () => {
  it('yields multiple deltas then a done event', async () => {
    const { client, calls } = fakeClient([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo ' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ])
    const adapter = createAnthropicAdapter({ createClient: () => client })
    const events = await collect(
      adapter.streamChat({ messages: [{ role: 'user', content: 'hi' }] }, ENV),
    )
    expect(events).toEqual([
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo ' },
      { type: 'delta', text: 'world' },
      { type: 'done', reason: 'end_turn' },
    ])
    // Sanity: we asked the SDK for a streamed completion exactly once.
    expect(calls).toHaveLength(1)
  })

  it('maps system to the top-level param and messages to content blocks (temperature ignored)', async () => {
    const { client, calls } = fakeClient([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
    const adapter = createAnthropicAdapter({ createClient: () => client })
    await collect(
      adapter.streamChat(
        {
          model: 'claude-sonnet-5',
          system: 'You are a face.',
          temperature: 0.9,
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
          ],
        },
        ENV,
      ),
    )
    const { body } = calls[0]
    expect(body.model).toBe('claude-sonnet-5')
    expect(body.system).toBe('You are a face.')
    expect(body.messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ])
    expect(body.stream).toBe(true)
    expect(typeof body.max_tokens).toBe('number')
    // temperature is intentionally NOT forwarded (rejected on opus-4-8 / sonnet-5).
    expect('temperature' in body).toBe(false)
  })

  it('falls back to the default model when the request omits one', async () => {
    const { client, calls } = fakeClient([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }])
    const adapter = createAnthropicAdapter({ createClient: () => client })
    await collect(adapter.streamChat({ messages: [{ role: 'user', content: 'hi' }] }, ENV))
    expect(calls[0].body.model).toBe('claude-opus-4-8')
  })

  it('ignores thinking deltas and only emits assistant text', async () => {
    const { client } = fakeClient([
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])
    const adapter = createAnthropicAdapter({ createClient: () => client })
    const events = await collect(
      adapter.streamChat({ messages: [{ role: 'user', content: 'q' }] }, ENV),
    )
    expect(events).toEqual([
      { type: 'delta', text: 'answer' },
      { type: 'done', reason: 'end_turn' },
    ])
  })
})

describe('anthropic adapter — abort & errors', () => {
  it('throws unavailable when no API key is present', async () => {
    const adapter = createAnthropicAdapter()
    await expect(
      collect(adapter.streamChat({ messages: [{ role: 'user', content: 'x' }] }, {})),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('stops emitting deltas once the signal is aborted (barge-in)', async () => {
    const controller = new AbortController()
    const { client } = fakeClient([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'one' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'two' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'three' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])
    const adapter = createAnthropicAdapter({ createClient: () => client })
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
    // Only the first delta made it through; the rest were cut off.
    expect(received).toEqual([{ type: 'delta', text: 'one' }])
    expect(caught).toBeInstanceOf(AdapterError)
    expect((caught as AdapterError).code).toBe('aborted')
  })

  it('normalizes an upstream 401 into an unauthorized AdapterError', async () => {
    const throwing = {
      messages: {
        stream() {
          return (async function* () {
            const err: any = new Error('invalid x-api-key')
            err.status = 401
            throw err
            // eslint-disable-next-line no-unreachable
            yield undefined as never
          })()
        },
      },
    }
    const adapter = createAnthropicAdapter({ createClient: () => throwing })
    await expect(
      collect(adapter.streamChat({ messages: [{ role: 'user', content: 'x' }] }, ENV)),
    ).rejects.toMatchObject({ code: 'unauthorized', provider: 'anthropic', status: 401 })
  })

  it('maps an AbortError thrown by the SDK to an aborted AdapterError', async () => {
    const aborting = {
      messages: {
        stream() {
          return (async function* () {
            const err = Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })
            throw err
            // eslint-disable-next-line no-unreachable
            yield undefined as never
          })()
        },
      },
    }
    const adapter = createAnthropicAdapter({ createClient: () => aborting })
    await expect(
      collect(adapter.streamChat({ messages: [{ role: 'user', content: 'x' }] }, ENV)),
    ).rejects.toMatchObject({ code: 'aborted' })
  })
})
