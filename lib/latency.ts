// Turn-latency instrumentation — the ruler for "the face takes forever to
// answer". One record per conversation turn, marks anchored at t0 =
// submitAudio/submitText entry, and ONE headline number:
//
//   ttfwMs — speak-stop → first AUDIBLE reply word (time-to-first-word).
//
// Honesty note: for VAD turns the endpointing tail (the silence the Silero
// redemption window consumes BEFORE the app can observe speech-end) elapses
// inside @ricky0123/vad-web, so it is not measurable per turn. It is carried
// as the `vadTailMs` CONSTANT and added into `ttfwMs` — every consumer must
// label it as estimated-from-constant, never as a measurement.
//
// Pure and injectable (clock via deps) so vitest owns it completely; the
// orchestrator owns one instance and the view layer only formats.

export type TurnInput = 'vad' | 'ptt' | 'typed'

export type TurnOutcome = 'complete' | 'aborted' | 'error' | 'empty'

/** Marks the orchestrator drops as a turn progresses (offsets from t0, ms). */
export type TimingMark =
  | 'sttEnd'
  | 'chatStart'
  | 'firstToken'
  | 'firstSentence'
  | 'ttsStart'
  | 'firstAudible'

export interface TurnTimings {
  v: 1
  /** Monotonic turn counter for the session (1-based). */
  turn: number
  input: TurnInput
  /** Absolute clock() at t0 — ordering only, never shipped by toLine(). */
  startedAt: number
  /** VAD endpointing tail (constant, estimated — see module header). */
  vadTailMs?: number
  /** t0 → transcript resolved. */
  sttMs?: number
  sttEngine?: string
  sttBackend?: string
  /** Server-measured upstream STT time (SttResult.latencyMs, hosted only). */
  sttUpstreamMs?: number
  /** t0 → runChat dispatched. */
  chatStartMs?: number
  /** t0 → first streamed token observed by the client. */
  ttftMs?: number
  /** t0 → first complete sentence handed to TTS. */
  firstSentenceMs?: number
  /** t0 → TTS router took the sentence (pre-audible). */
  ttsStartMs?: number
  /** t0 → real audio began (u.onstart / el 'playing'). */
  firstAudibleMs?: number
  /** firstAudibleMs + (vadTailMs ?? 0) — THE metric. */
  ttfwMs?: number
  provider?: string
  model?: string
  ttsEngine?: string
  outcome?: TurnOutcome
}

const MARK_FIELD: Record<TimingMark, keyof TurnTimings> = {
  sttEnd: 'sttMs',
  chatStart: 'chatStartMs',
  firstToken: 'ttftMs',
  firstSentence: 'firstSentenceMs',
  ttsStart: 'ttsStartMs',
  firstAudible: 'firstAudibleMs',
}

const DEFAULT_CAPACITY = 20

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

export class TurnTimingsRecorder {
  private readonly now: () => number
  private readonly capacity: number
  private inFlight: TurnTimings | null = null
  private turns = 0
  private ring: TurnTimings[] = []

  constructor(deps: { now?: () => number; capacity?: number } = {}) {
    this.now = deps.now ?? defaultNow
    this.capacity = deps.capacity ?? DEFAULT_CAPACITY
  }

  /** Start a turn record; an in-flight record ends as 'aborted' (barge-in). */
  begin(input: TurnInput, meta: { vadTailMs?: number } = {}): void {
    if (this.inFlight) this.end('aborted')
    this.turns += 1
    this.inFlight = {
      v: 1,
      turn: this.turns,
      input,
      startedAt: this.now(),
      ...(meta.vadTailMs !== undefined && input === 'vad'
        ? { vadTailMs: meta.vadTailMs }
        : {}),
    }
  }

  /** Drop a mark (offset from t0). First-wins; no-op with no turn in flight. */
  mark(key: TimingMark): void {
    const t = this.inFlight
    if (!t) return
    const field = MARK_FIELD[key]
    if (t[field] !== undefined) return
    const offset = this.now() - t.startedAt
    ;(t as unknown as Record<string, number>)[field] = offset
    if (key === 'firstAudible') t.ttfwMs = offset + (t.vadTailMs ?? 0)
  }

  /** Attach non-timing facts (engines, provider, upstream sub-timings). */
  annotate(patch: Partial<TurnTimings>): void {
    if (!this.inFlight) return
    Object.assign(this.inFlight, patch)
  }

  /** Finalize the in-flight record into the ring. Null when none in flight. */
  end(outcome: TurnOutcome): TurnTimings | null {
    const t = this.inFlight
    if (!t) return null
    t.outcome = outcome
    this.inFlight = null
    this.ring.push(t)
    if (this.ring.length > this.capacity) this.ring.shift()
    return t
  }

  current(): TurnTimings | null {
    return this.inFlight
  }

  log(): readonly TurnTimings[] {
    return this.ring
  }
}

/**
 * One JSON line per turn — the shared shape the Pi-side (hermes) measurements
 * replicate. Integer ms, no undefined fields, no absolute clock values.
 */
export function toLine(t: TurnTimings): string {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(t)) {
    if (value === undefined || key === 'startedAt') continue
    out[key] = typeof value === 'number' && key !== 'v' && key !== 'turn'
      ? Math.round(value)
      : value
  }
  return JSON.stringify(out)
}

/** Compact HUD readout: "VAD 1.4 · STT 0.9 · TTFT 8.2 · TTS 0.4 · TTFW 10.5s". */
export function formatLatencyReadout(t: TurnTimings): string {
  // Round half-up at 0.1 s — toFixed alone turns 10.45 into "10.4" (float rep).
  const s = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1)
  const parts: string[] = []
  if (t.vadTailMs !== undefined) parts.push(`VAD ${s(t.vadTailMs)}`)
  if (t.sttMs !== undefined) parts.push(`STT ${s(t.sttMs)}`)
  if (t.ttftMs !== undefined) parts.push(`TTFT ${s(t.ttftMs)}`)
  if (t.firstAudibleMs !== undefined && t.firstSentenceMs !== undefined) {
    parts.push(`TTS ${s(t.firstAudibleMs - t.firstSentenceMs)}`)
  }
  if (t.ttfwMs !== undefined) parts.push(`TTFW ${s(t.ttfwMs)}s`)
  return parts.join(' · ')
}
