// The hosted, high-quality voice-out route. Voice-out defaults to the browser
// Web Speech API (zero infra); when OPENAI_API_KEY is set the client can upgrade
// to OpenAI's streamed `gpt-4o-mini-tts` for real FFT-driven lip-sync. This
// route accepts POST { text, voice, format } and streams the audio bytes back so
// playback (and the wawa-lipsync analyser tap) can start before the full clip
// arrives.
//
// All the logic lives in `lib/tts/hosted.ts` (env + fetch injected) so it is
// headlessly unit-testable; this file just supplies the real dependencies.
// OPENAI_API_KEY stays server-side — never echoed. A missing key returns a typed
// `unavailable` error the client handles by falling back to Web Speech.

import { synthesizeHosted } from '@/lib/tts/hosted'

// Streams upstream audio bytes and honors request.signal for barge-in — Node
// runtime, generous duration for longer utterances.
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: Request): Promise<Response> {
  return synthesizeHosted(request, { env: process.env })
}
