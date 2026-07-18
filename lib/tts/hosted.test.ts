// @vitest-environment node
// This route runs on the Next.js Node runtime and streams raw audio bytes back.
// Pin to `node` so Response/ReadableStream come from the same realm as the
// server runtime (jsdom swaps these for a different global).
import { describe, expect, it, vi } from 'vitest'
import {
  synthesizeHosted,
  MAX_TTS_CHARS,
  contentTypeFor,
  type HostedTtsEnv,
} from '@/lib/tts/hosted'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a JSON POST to /api/tts. */
function ttsRequest(
  body: unknown,
  opts: { signal?: AbortSignal } = {},
): Request {
  return new Request('http://localhost/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: opts.signal,
  })
}

/** A fake `fetch` returning a streamed audio body, recording the call. */
function okFetch(bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    // Emit in two chunks so we can assert the response is a *stream*.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4))
        controller.enqueue(bytes.slice(4))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synthesizeHosted', () => {
  it('streams gpt-4o-mini-tts audio from OpenAI when OPENAI_API_KEY is set', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await synthesizeHosted(ttsRequest({ text: 'Hello there.' }), {
      env,
      fetch: fetchImpl,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    // A stream body, not a buffered blob — no proxy buffering.
    expect(res.body).toBeInstanceOf(ReadableStream)
    expect(res.headers.get('x-accel-buffering')).toBe('no')
    const buf = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(buf)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/speech')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer sk-fake')
    const sent = JSON.parse(calls[0].init.body as string)
    expect(sent.model).toBe('gpt-4o-mini-tts')
    expect(sent.input).toBe('Hello there.')
    expect(sent.response_format).toBe('mp3')
    expect(typeof sent.voice).toBe('string')
  })

  it('honors a request voice + format and maps the Content-Type', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await synthesizeHosted(
      ttsRequest({ text: 'Hi', voice: 'shimmer', format: 'opus' }),
      { env, fetch: fetchImpl },
    )
    expect(res.headers.get('content-type')).toBe('audio/ogg')
    const sent = JSON.parse(calls[0].init.body as string)
    expect(sent.voice).toBe('shimmer')
    expect(sent.response_format).toBe('opus')
  })

  it('falls back to the default voice when the requested voice is unknown', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake', OPENAI_TTS_VOICE: 'nova' }
    await synthesizeHosted(ttsRequest({ text: 'Hi', voice: 'not-a-voice' }), {
      env,
      fetch: fetchImpl,
    })
    const sent = JSON.parse(calls[0].init.body as string)
    expect(sent.voice).toBe('nova')
  })

  it('honors OPENAI_TTS_MODEL / OPENAI_TTS_FORMAT env knobs', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedTtsEnv = {
      OPENAI_API_KEY: 'sk-fake',
      OPENAI_TTS_MODEL: 'tts-1-hd',
      OPENAI_TTS_FORMAT: 'wav',
    }
    const res = await synthesizeHosted(ttsRequest({ text: 'Hi' }), { env, fetch: fetchImpl })
    expect(res.headers.get('content-type')).toBe('audio/wav')
    const sent = JSON.parse(calls[0].init.body as string)
    expect(sent.model).toBe('tts-1-hd')
    expect(sent.response_format).toBe('wav')
  })

  it('returns a typed unavailable error (client falls back to Web Speech) with no key', async () => {
    const { fetchImpl, calls } = okFetch()
    const res = await synthesizeHosted(ttsRequest({ text: 'Hi' }), { env: {}, fetch: fetchImpl })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('unavailable')
    expect(calls).toHaveLength(0)
  })

  it('rejects empty / whitespace-only text with NO upstream call', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await synthesizeHosted(ttsRequest({ text: '   ' }), { env, fetch: fetchImpl })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('bad_request')
    expect(calls).toHaveLength(0)
  })

  it('rejects oversize text before calling upstream', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake' }
    const huge = 'a'.repeat(MAX_TTS_CHARS + 1)
    const res = await synthesizeHosted(ttsRequest({ text: huge }), { env, fetch: fetchImpl })
    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error.code).toBe('bad_request')
    expect(calls).toHaveLength(0)
  })

  it('rejects a malformed JSON body', async () => {
    const { fetchImpl } = okFetch()
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await synthesizeHosted(ttsRequest('{not json'), { env, fetch: fetchImpl })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('bad_request')
  })

  it('normalizes an upstream 401 to unauthorized without leaking the key', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    ) as unknown as typeof fetch
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-bad' }
    const res = await synthesizeHosted(ttsRequest({ text: 'Hi' }), { env, fetch: fetchImpl })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('unauthorized')
    expect(JSON.stringify(body)).not.toContain('sk-bad')
  })

  it('normalizes an upstream 500 to a 502 upstream_error', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await synthesizeHosted(ttsRequest({ text: 'Hi' }), { env, fetch: fetchImpl })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.code).toBe('upstream_error')
  })

  it('maps an unreachable upstream (fetch TypeError) to a 502 network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await synthesizeHosted(ttsRequest({ text: 'Hi' }), { env, fetch: fetchImpl })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.code).toBe('network')
  })

  it('forwards the request abort signal to the upstream fetch', async () => {
    const controller = new AbortController()
    let seenSignal: AbortSignal | null | undefined
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([9]))
          c.close()
        },
      })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch
    const env: HostedTtsEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await synthesizeHosted(ttsRequest({ text: 'Hi' }, { signal: controller.signal }), {
      env,
      fetch: fetchImpl,
    })
    expect(res.status).toBe(200)
    // The route must pass request.signal straight through so barge-in aborts the
    // upstream synthesis. (The Request constructor wraps the controller's signal,
    // so assert propagation rather than referential identity.)
    expect(seenSignal).toBeInstanceOf(AbortSignal)
    expect(seenSignal?.aborted).toBe(false)
    controller.abort()
    expect(seenSignal?.aborted).toBe(true)
  })
})

describe('contentTypeFor', () => {
  it('maps every supported format to a MIME type', () => {
    expect(contentTypeFor('mp3')).toBe('audio/mpeg')
    expect(contentTypeFor('opus')).toBe('audio/ogg')
    expect(contentTypeFor('aac')).toBe('audio/aac')
    expect(contentTypeFor('flac')).toBe('audio/flac')
    expect(contentTypeFor('wav')).toBe('audio/wav')
    expect(contentTypeFor('pcm')).toBe('audio/pcm')
  })
})
