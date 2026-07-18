// The hosted speech-to-text fallback route. The client uses in-browser Whisper
// by default; when that path is unavailable (no WebGPU/WASM, model not cached,
// worker error) it POSTs the recorded clip here as multipart form-data with an
// `audio` field, and a hosted Whisper transcribes it — Groq
// `whisper-large-v3-turbo` when GROQ_API_KEY is set (cheapest/fastest), else
// OpenAI (`whisper-1` / `gpt-4o-transcribe`) as the fallback.
//
// All the logic lives in `lib/stt/hosted.ts` (env + fetch + clock injected) so
// it is headlessly unit-testable; this file just supplies the real dependencies.
// Both GROQ_API_KEY and OPENAI_API_KEY stay server-side — never echoed.

import { transcribeHosted } from '@/lib/stt/hosted'

// Multipart upload + upstream provider I/O — Node runtime, generous duration.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  return transcribeHosted(request, { env: process.env })
}
