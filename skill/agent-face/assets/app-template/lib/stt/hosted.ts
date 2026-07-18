// The hosted speech-to-text fallback — the server-side seam behind
// `/api/transcribe`. When the in-browser Whisper worker is unavailable (no
// WebGPU/WASM, model not cached, worker error), the client POSTs the recorded
// clip here and a hosted Whisper transcribes it. Provider selection is
// key-driven and cost-ordered: Groq's `whisper-large-v3-turbo` first (cheapest
// + fastest), else OpenAI (`whisper-1` / `gpt-4o-transcribe`) as the fallback.
//
// This module holds the pure logic (env + fetch + clock injected) so it is
// fully headlessly testable with no network; `app/api/transcribe/route.ts` is a
// thin wrapper that supplies the real `process.env`, `fetch`, and `Date.now`.

import { AdapterError, statusForAdapterError } from '@/lib/providers/types'
import { errorForStatus, normalizeError } from '@/lib/providers/sse'

/**
 * Hard cap on the audio blob itself — comfortably under Vercel's ~4.5 MB request
 * limit so the multipart envelope (field names, boundaries, extra fields) still
 * fits. Anything larger is rejected with 413 BEFORE any upstream call.
 */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024

/**
 * Early guard on the whole request via Content-Length: a bit of headroom over
 * the audio cap for the multipart overhead, but still well under the 4.5 MB cap.
 */
const MAX_REQUEST_BYTES = 4.4 * 1024 * 1024

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'

/** Groq's single hosted Whisper model — fixed (cheapest + fastest turbo). */
const GROQ_MODEL = 'whisper-large-v3-turbo'
/** OpenAI's default transcription model when `OPENAI_TRANSCRIBE_MODEL` is unset. */
const OPENAI_DEFAULT_MODEL = 'whisper-1'

/**
 * The env this route reads. An indexed alias (like `ProviderEnv`) so the real
 * `process.env` satisfies it directly; the named keys below document what is
 * actually consulted: GROQ_API_KEY, OPENAI_API_KEY, OPENAI_TRANSCRIBE_MODEL,
 * OPENAI_TRANSCRIBE_LANGUAGE, OPENAI_TRANSCRIBE_PROMPT.
 */
export type HostedSttEnv = Record<string, string | undefined>

/** Injectable dependencies so the route is testable without network/clock. */
export interface HostedSttDeps {
  env: HostedSttEnv
  /** Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Defaults to `Date.now`; injected for deterministic `latencyMs` in tests. */
  now?: () => number
}

/** The successful JSON payload the client consumes. */
export interface TranscribeResult {
  text: string
  provider: 'groq' | 'openai'
  model: string
  latencyMs: number
}

/** A resolved upstream provider + the credentials/params to call it with. */
interface SelectedProvider {
  id: 'groq' | 'openai'
  label: string
  url: string
  apiKey: string
  model: string
}

/**
 * Pick the hosted STT provider from the env. Groq wins when present (cheapest +
 * fastest), else OpenAI. Returns `null` when no hosted key is configured — the
 * caller then tells the client to use the in-browser Whisper path instead.
 */
function selectProvider(env: HostedSttEnv): SelectedProvider | null {
  if (env.GROQ_API_KEY) {
    return {
      id: 'groq',
      label: 'Groq',
      url: GROQ_TRANSCRIBE_URL,
      apiKey: env.GROQ_API_KEY,
      model: GROQ_MODEL,
    }
  }
  if (env.OPENAI_API_KEY) {
    return {
      id: 'openai',
      label: 'OpenAI',
      url: OPENAI_TRANSCRIBE_URL,
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_TRANSCRIBE_MODEL?.trim() || OPENAI_DEFAULT_MODEL,
    }
  }
  return null
}

/**
 * Transcribe a multipart audio upload via a hosted Whisper. Pure over its
 * injected deps: parses the `audio` field, guards size (413), selects a provider
 * (400 `unavailable` if none), forwards to the provider's OpenAI-compatible
 * `/audio/transcriptions` endpoint, and returns `{ text, provider, model,
 * latencyMs }`. Upstream/refusal errors normalize to safe JSON with the right
 * status; no secret ever appears in the response.
 */
export async function transcribeHosted(
  request: Request,
  deps: HostedSttDeps,
): Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const env = deps.env

  // 1) Early size guard via Content-Length (avoids buffering a huge upload).
  const declaredLength = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return errorResponse(new AdapterError('bad_request', 'Audio upload too large.'), 413)
  }

  // 2) Select the provider FIRST — with no hosted key there is nothing to do, so
  //    fail fast (the client falls back to in-browser Whisper).
  const provider = selectProvider(env)
  if (!provider) {
    return errorResponse(
      new AdapterError(
        'unavailable',
        'No hosted STT is configured. Set GROQ_API_KEY or OPENAI_API_KEY, or use in-browser Whisper.',
      ),
    )
  }

  // 3) Parse the multipart body and pull the `audio` field.
  let audio: Blob
  let language: string | undefined
  let prompt: string | undefined
  try {
    const form = await request.formData()
    const field = form.get('audio')
    if (!isBlobLike(field) || field.size === 0) {
      return errorResponse(
        new AdapterError('bad_request', 'Missing multipart "audio" field.'),
      )
    }
    audio = field
    // Per-request settings passthrough, falling back to the OpenAI env knobs.
    language = firstString(form.get('language')) ?? emptyToUndef(env.OPENAI_TRANSCRIBE_LANGUAGE)
    prompt = firstString(form.get('prompt')) ?? emptyToUndef(env.OPENAI_TRANSCRIBE_PROMPT)
  } catch {
    return errorResponse(new AdapterError('bad_request', 'Invalid multipart form data.'))
  }

  // 4) Precise size guard on the audio blob — reject BEFORE any upstream call.
  if (audio.size > MAX_AUDIO_BYTES) {
    return errorResponse(new AdapterError('bad_request', 'Audio clip too large.'), 413)
  }

  // 5) Build the OpenAI-compatible multipart request and forward it.
  const upstreamForm = new FormData()
  upstreamForm.append('file', audio, filenameFor(audio))
  upstreamForm.append('model', provider.model)
  upstreamForm.append('response_format', 'json')
  if (language) upstreamForm.append('language', language)
  if (prompt) upstreamForm.append('prompt', prompt)

  const startedAt = now()
  let upstream: Response
  try {
    upstream = await fetchImpl(provider.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      body: upstreamForm,
      signal: request.signal,
    })
  } catch (err) {
    // Unreachable endpoint / abort — normalize (never leak the key).
    return errorResponse(normalizeError(err, provider.label))
  }

  if (!upstream.ok) {
    // Normalize the status to a typed code; do NOT echo the upstream body (it
    // could, in theory, reflect request material). A short, safe hint only.
    return errorResponse(errorForStatus(upstream.status, provider.label))
  }

  // 6) Parse the transcript. Both providers return `{ text }` for JSON format.
  let text: string
  try {
    const data = (await upstream.json()) as { text?: unknown }
    text = typeof data.text === 'string' ? data.text : ''
  } catch {
    return errorResponse(
      new AdapterError('upstream_error', `${provider.label} returned a malformed response.`, {
        provider: provider.label,
        status: 502,
      }),
    )
  }

  const result: TranscribeResult = {
    text,
    provider: provider.id,
    model: provider.model,
    latencyMs: Math.max(0, Math.round(now() - startedAt)),
  }
  return Response.json(result, { status: 200 })
}

/**
 * Duck-typed Blob/File check. A strict `instanceof Blob` is unreliable across
 * JS realms (the runtime's `Request.formData()` yields undici File objects that
 * fail `instanceof` against a different global `Blob`), so we test for the
 * blob-like surface (`size` + `arrayBuffer`) instead — which also correctly
 * rejects plain string form fields.
 */
function isBlobLike(value: FormDataEntryValue | null): value is File {
  return (
    value != null &&
    typeof value !== 'string' &&
    typeof (value as Blob).size === 'number' &&
    typeof (value as Blob).arrayBuffer === 'function'
  )
}

/** Return a non-empty trimmed string from a form value, else `undefined`. */
function firstString(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Trim an env value to a non-empty string, else `undefined`. */
function emptyToUndef(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Pick a filename for the upstream `file` part. OpenAI/Groq infer the audio
 * format from the extension, so derive one from the blob's MIME type.
 */
function filenameFor(audio: Blob): string {
  const type = audio.type || ''
  if (type.includes('webm')) return 'audio.webm'
  if (type.includes('mp4') || type.includes('m4a')) return 'audio.mp4'
  if (type.includes('ogg')) return 'audio.ogg'
  if (type.includes('wav')) return 'audio.wav'
  if (type.includes('mpeg') || type.includes('mp3')) return 'audio.mp3'
  return 'audio.webm'
}

/**
 * Build a JSON error `Response`. The HTTP status is the code's mapped status
 * (499 "client closed" clamped to 400), UNLESS an explicit `httpStatus` is
 * passed for the client-side guards (413). Note: an error's own `status` field
 * is the UPSTREAM status carried in the body shape (e.g. 500), not the status we
 * return — an upstream 500 surfaces to the client as a 502.
 */
function errorResponse(err: unknown, httpStatus?: number): Response {
  const adapterErr =
    err instanceof AdapterError ? err : new AdapterError('unknown', 'Unexpected error.')
  const mapped = statusForAdapterError(adapterErr.code)
  const status = httpStatus ?? (mapped === 499 ? 400 : mapped)
  return Response.json({ error: adapterErr.toShape() }, { status })
}
