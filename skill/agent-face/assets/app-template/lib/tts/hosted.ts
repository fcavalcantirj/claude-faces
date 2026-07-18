// The hosted, high-quality text-to-speech seam behind `/api/tts`. Voice-out
// defaults to the browser Web Speech API (zero infra); when OPENAI_API_KEY is
// set the client can upgrade to OpenAI's streamed `gpt-4o-mini-tts` for
// FFT-driven lip-sync. This route streams the audio bytes straight back to the
// client — playback (and the wawa-lipsync analyser tap) starts before the full
// clip arrives.
//
// The pure logic lives here (env + fetch injected) so it is fully headlessly
// testable with no network; `app/api/tts/route.ts` is a thin wrapper that
// supplies the real `process.env` and `fetch`. OPENAI_API_KEY stays server-side
// and is never echoed. A missing key returns a typed `unavailable` error the
// client handles by falling back to Web Speech.

import { AdapterError, statusForAdapterError } from '@/lib/providers/types'
import { errorForStatus, normalizeError } from '@/lib/providers/sse'

/**
 * OpenAI's own hard limit on a single `/audio/speech` request is 4096 chars.
 * The orchestrator chunks per sentence and requests TTS incrementally, so any
 * single request over this cap is a client bug — reject it (413) before the
 * upstream call rather than letting OpenAI 400 us.
 */
export const MAX_TTS_CHARS = 4096

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech'

/** OpenAI's default TTS model when `OPENAI_TTS_MODEL` is unset. */
const DEFAULT_MODEL = 'gpt-4o-mini-tts'
/** The voice used when neither the request nor `OPENAI_TTS_VOICE` names one. */
const DEFAULT_VOICE = 'alloy'
/** The streamed audio format when neither request nor `OPENAI_TTS_FORMAT` set. */
const DEFAULT_FORMAT: TtsFormat = 'mp3'

/** The voices gpt-4o-mini-tts / tts-1 accept. An unknown voice falls back. */
const OPENAI_VOICES = new Set([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
])

/** The streamed audio formats OpenAI can emit, mapped to their MIME types. */
const FORMAT_CONTENT_TYPE = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
} as const

export type TtsFormat = keyof typeof FORMAT_CONTENT_TYPE

/** The MIME `Content-Type` the streamed response should carry for a format. */
export function contentTypeFor(format: TtsFormat): string {
  return FORMAT_CONTENT_TYPE[format]
}

/**
 * The env this route reads. An indexed alias (like `ProviderEnv`) so the real
 * `process.env` satisfies it directly; the named keys below document what is
 * actually consulted: OPENAI_API_KEY, OPENAI_TTS_MODEL, OPENAI_TTS_VOICE,
 * OPENAI_TTS_FORMAT.
 */
export type HostedTtsEnv = Record<string, string | undefined>

/** Injectable dependencies so the route is testable without network. */
export interface HostedTtsDeps {
  env: HostedTtsEnv
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
}

/** The parsed, validated request body. */
interface TtsInput {
  text: string
  voice: string
  format: TtsFormat
  model: string
}

/**
 * Synthesize speech via OpenAI's streamed `/audio/speech`. Pure over its
 * injected deps: parses `{ text, voice, format }`, requires OPENAI_API_KEY
 * (400 `unavailable` if absent so the client uses Web Speech), validates text
 * length (400 empty / 413 oversize), then streams the upstream audio body back
 * with the right `Content-Type` and no proxy buffering. Upstream failures
 * normalize to safe JSON; the API key never appears in a response.
 */
export async function synthesizeHosted(
  request: Request,
  deps: HostedTtsDeps,
): Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch
  const env = deps.env

  // 1) Require the OpenAI key FIRST — with no key there is nothing to do, so
  //    fail fast with a typed error the client maps to a Web Speech fallback.
  const apiKey = env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return errorResponse(
      new AdapterError(
        'unavailable',
        'No hosted TTS is configured. Set OPENAI_API_KEY, or use the browser Web Speech API.',
      ),
    )
  }

  // 2) Parse the JSON body.
  let body: Record<string, unknown>
  try {
    const raw = await request.json()
    if (raw === null || typeof raw !== 'object') {
      return errorResponse(new AdapterError('bad_request', 'Expected a JSON object body.'))
    }
    body = raw as Record<string, unknown>
  } catch {
    return errorResponse(new AdapterError('bad_request', 'Invalid JSON body.'))
  }

  // 3) Validate text: reject empty (400) / oversize (413) BEFORE any upstream call.
  const text = typeof body.text === 'string' ? body.text : ''
  if (text.trim().length === 0) {
    return errorResponse(new AdapterError('bad_request', 'Missing "text" to synthesize.'))
  }
  if (text.length > MAX_TTS_CHARS) {
    return errorResponse(
      new AdapterError('bad_request', `Text exceeds the ${MAX_TTS_CHARS}-char limit.`),
      413,
    )
  }

  const input = resolveOptions(text, body, env)

  // 4) Forward to OpenAI, streaming the audio bytes straight through.
  let upstream: Response
  try {
    upstream = await fetchImpl(OPENAI_SPEECH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        voice: input.voice,
        input: input.text,
        response_format: input.format,
      }),
      // Honor barge-in / client disconnect: aborting the request aborts synthesis.
      signal: request.signal,
    })
  } catch (err) {
    return errorResponse(normalizeError(err, 'OpenAI'))
  }

  if (!upstream.ok || !upstream.body) {
    // Do NOT echo the upstream body (could reflect request material). A safe,
    // typed error mapped from the status only.
    return errorResponse(errorForStatus(upstream.status, 'OpenAI'))
  }

  // 5) Stream the audio through untouched. No buffering: playback (and the
  //    wawa-lipsync analyser tap) can begin before the full clip arrives.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': contentTypeFor(input.format),
      'cache-control': 'no-store',
      // Disable proxy/CDN response buffering so the first bytes flush promptly.
      'x-accel-buffering': 'no',
    },
  })
}

/**
 * Resolve the voice / format / model for a (validated, non-empty) text. An
 * unknown voice or format degrades to the configured default rather than
 * erroring — a forgiving contract for the orchestrator's incremental requests.
 */
function resolveOptions(
  text: string,
  body: Record<string, unknown>,
  env: HostedTtsEnv,
): TtsInput {
  const requestedVoice = typeof body.voice === 'string' ? body.voice.trim() : ''
  const envVoice = env.OPENAI_TTS_VOICE?.trim() || DEFAULT_VOICE
  const voice = OPENAI_VOICES.has(requestedVoice) ? requestedVoice : envVoice

  const requestedFormat = typeof body.format === 'string' ? body.format.trim() : ''
  const envFormat = env.OPENAI_TTS_FORMAT?.trim() || DEFAULT_FORMAT
  const format = isTtsFormat(requestedFormat)
    ? requestedFormat
    : isTtsFormat(envFormat)
      ? envFormat
      : DEFAULT_FORMAT

  const model = env.OPENAI_TTS_MODEL?.trim() || DEFAULT_MODEL

  return { text, voice, format, model }
}

/** Type guard: is `value` one of the supported audio formats? */
function isTtsFormat(value: string): value is TtsFormat {
  return value in FORMAT_CONTENT_TYPE
}

/**
 * Build a JSON error `Response`. The HTTP status is the code's mapped status
 * (499 "client closed" clamped to 400) unless an explicit `httpStatus` is passed
 * (413 for oversize). An error's own `status` field is the UPSTREAM status
 * carried in the body, not the status we return.
 */
function errorResponse(err: unknown, httpStatus?: number): Response {
  const adapterErr =
    err instanceof AdapterError ? err : new AdapterError('unknown', 'Unexpected error.')
  const mapped = statusForAdapterError(adapterErr.code)
  const status = httpStatus ?? (mapped === 499 ? 400 : mapped)
  return Response.json({ error: adapterErr.toShape() }, { status })
}
