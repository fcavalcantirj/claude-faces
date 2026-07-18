// @vitest-environment node
// This route runs on the Next.js Node runtime and manipulates multipart
// FormData/Blob. jsdom overrides those globals with a different realm than
// undici's `Request.formData()`, causing cross-realm `instanceof`/`append`
// failures that never occur in production — so pin this file to `node`.
import { describe, expect, it, vi } from 'vitest'
import { transcribeHosted, MAX_AUDIO_BYTES, type HostedSttEnv } from '@/lib/stt/hosted'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a multipart POST to /api/transcribe carrying an `audio` blob. */
function transcribeRequest(
  opts: {
    audio?: Blob | null
    filename?: string
    language?: string
    prompt?: string
    signal?: AbortSignal
    contentLength?: number
  } = {},
): Request {
  const form = new FormData()
  if (opts.audio !== null) {
    const blob = opts.audio ?? new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' })
    form.append('audio', blob, opts.filename ?? 'clip.webm')
  }
  if (opts.language) form.append('language', opts.language)
  if (opts.prompt) form.append('prompt', opts.prompt)
  const headers: Record<string, string> = {}
  if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength)
  return new Request('http://localhost/api/transcribe', {
    method: 'POST',
    headers,
    body: form,
    signal: opts.signal,
  })
}

/** A fake `fetch` that returns a JSON transcription and records the call. */
function okFetch(text = 'hello world') {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A `now()` seam that ticks forward a fixed amount per call for stable latencyMs. */
function scriptedNow(values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transcribeHosted', () => {
  it('uses Groq whisper-large-v3-turbo when GROQ_API_KEY is set', async () => {
    const { fetchImpl, calls } = okFetch('groq transcript')
    const env: HostedSttEnv = { GROQ_API_KEY: 'gsk-fake', OPENAI_API_KEY: 'sk-fake' }
    const res = await transcribeHosted(transcribeRequest(), {
      env,
      fetch: fetchImpl,
      now: scriptedNow([1000, 1250]),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      text: 'groq transcript',
      provider: 'groq',
      model: 'whisper-large-v3-turbo',
      latencyMs: 250,
    })
    // Preferred Groq (cheapest/fastest) even though OpenAI is also configured.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    const auth = new Headers(calls[0].init.headers).get('authorization')
    expect(auth).toBe('Bearer gsk-fake')
    const sentForm = calls[0].init.body as FormData
    expect(sentForm.get('model')).toBe('whisper-large-v3-turbo')
    expect(sentForm.get('file')).toBeInstanceOf(Blob)
  })

  it('falls back to OpenAI (whisper-1 default) when only OPENAI_API_KEY is set', async () => {
    const { fetchImpl, calls } = okFetch('openai transcript')
    const env: HostedSttEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await transcribeHosted(transcribeRequest(), {
      env,
      fetch: fetchImpl,
      now: scriptedNow([0, 42]),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.provider).toBe('openai')
    expect(body.model).toBe('whisper-1')
    expect(body.text).toBe('openai transcript')
    expect(body.latencyMs).toBe(42)
    expect(calls[0].url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer sk-fake')
  })

  it('honors OPENAI_TRANSCRIBE_MODEL + language/prompt env knobs', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedSttEnv = {
      OPENAI_API_KEY: 'sk-fake',
      OPENAI_TRANSCRIBE_MODEL: 'gpt-4o-transcribe',
      OPENAI_TRANSCRIBE_LANGUAGE: 'en',
      OPENAI_TRANSCRIBE_PROMPT: 'Claude Faces, wawa-lipsync',
    }
    const res = await transcribeHosted(transcribeRequest(), { env, fetch: fetchImpl })
    const body = await res.json()
    expect(body.model).toBe('gpt-4o-transcribe')
    const sentForm = calls[0].init.body as FormData
    expect(sentForm.get('model')).toBe('gpt-4o-transcribe')
    expect(sentForm.get('language')).toBe('en')
    expect(sentForm.get('prompt')).toBe('Claude Faces, wawa-lipsync')
  })

  it('lets a request language/prompt field override the env default', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedSttEnv = { OPENAI_API_KEY: 'sk-fake', OPENAI_TRANSCRIBE_LANGUAGE: 'en' }
    await transcribeHosted(transcribeRequest({ language: 'pt', prompt: 'olá' }), {
      env,
      fetch: fetchImpl,
    })
    const sentForm = calls[0].init.body as FormData
    expect(sentForm.get('language')).toBe('pt')
    expect(sentForm.get('prompt')).toBe('olá')
  })

  it('returns 413 for an oversize clip with NO upstream call', async () => {
    const { fetchImpl, calls } = okFetch()
    const big = new Blob([new Uint8Array(MAX_AUDIO_BYTES + 1)], { type: 'audio/webm' })
    const env: HostedSttEnv = { GROQ_API_KEY: 'gsk-fake' }
    const res = await transcribeHosted(transcribeRequest({ audio: big }), {
      env,
      fetch: fetchImpl,
    })

    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error.code).toBe('bad_request')
    expect(calls).toHaveLength(0) // never touched the network
  })

  it('rejects an oversize request via Content-Length before parsing', async () => {
    const { fetchImpl, calls } = okFetch()
    const env: HostedSttEnv = { GROQ_API_KEY: 'gsk-fake' }
    const res = await transcribeHosted(
      transcribeRequest({ contentLength: 50 * 1024 * 1024 }),
      { env, fetch: fetchImpl },
    )
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('returns 400 when no hosted STT key is configured', async () => {
    const { fetchImpl, calls } = okFetch()
    const res = await transcribeHosted(transcribeRequest(), { env: {}, fetch: fetchImpl })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('unavailable')
    expect(calls).toHaveLength(0)
  })

  it('returns 400 when the audio field is missing', async () => {
    const { fetchImpl } = okFetch()
    const env: HostedSttEnv = { GROQ_API_KEY: 'gsk-fake' }
    const res = await transcribeHosted(transcribeRequest({ audio: null }), {
      env,
      fetch: fetchImpl,
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('bad_request')
  })

  it('normalizes an upstream 401 to a typed unauthorized error (no secret leak)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }),
    ) as unknown as typeof fetch
    const env: HostedSttEnv = { GROQ_API_KEY: 'gsk-bad' }
    const res = await transcribeHosted(transcribeRequest(), { env, fetch: fetchImpl })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('unauthorized')
    expect(JSON.stringify(body)).not.toContain('gsk-bad')
  })

  it('normalizes an upstream 500 to a 502 upstream_error', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('server exploded', { status: 500 }),
    ) as unknown as typeof fetch
    const env: HostedSttEnv = { OPENAI_API_KEY: 'sk-fake' }
    const res = await transcribeHosted(transcribeRequest(), { env, fetch: fetchImpl })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.code).toBe('upstream_error')
  })

  it('maps an unreachable upstream (fetch TypeError) to a 502 network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const env: HostedSttEnv = { GROQ_API_KEY: 'gsk-fake' }
    const res = await transcribeHosted(transcribeRequest(), { env, fetch: fetchImpl })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.code).toBe('network')
  })
})
