import { describe, it, expect } from 'vitest'
import {
  TurnTimingsRecorder,
  formatLatencyReadout,
  toLine,
  type TurnTimings,
} from './latency'

/** A hand-stepped clock: now() returns the last value pushed via tick(). */
function makeClock(start = 1000) {
  let t = start
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms
    },
  }
}

describe('TurnTimingsRecorder', () => {
  it('records per-stage offsets from t0 for a vad turn and adds the vad tail into ttfw', () => {
    const clock = makeClock()
    const rec = new TurnTimingsRecorder({ now: clock.now })

    rec.begin('vad', { vadTailMs: 1400 })
    clock.tick(900)
    rec.mark('sttEnd')
    rec.annotate({ sttEngine: 'hosted', sttUpstreamMs: 640 })
    clock.tick(100)
    rec.mark('chatStart')
    clock.tick(7000)
    rec.mark('firstToken')
    clock.tick(400)
    rec.mark('firstSentence')
    clock.tick(20)
    rec.mark('ttsStart')
    clock.tick(380)
    rec.mark('firstAudible')
    const t = rec.end('complete')

    expect(t).not.toBeNull()
    expect(t!.input).toBe('vad')
    expect(t!.vadTailMs).toBe(1400)
    expect(t!.sttMs).toBe(900)
    expect(t!.sttEngine).toBe('hosted')
    expect(t!.sttUpstreamMs).toBe(640)
    expect(t!.chatStartMs).toBe(1000)
    expect(t!.ttftMs).toBe(8000)
    expect(t!.firstSentenceMs).toBe(8400)
    expect(t!.ttsStartMs).toBe(8420)
    expect(t!.firstAudibleMs).toBe(8800)
    // The headline metric includes the endpointing tail the app cannot observe.
    expect(t!.ttfwMs).toBe(8800 + 1400)
    expect(t!.outcome).toBe('complete')
  })

  it('a typed turn has no stt/vad fields and ttfw equals firstAudible', () => {
    const clock = makeClock()
    const rec = new TurnTimingsRecorder({ now: clock.now })
    rec.begin('typed')
    clock.tick(3000)
    rec.mark('firstToken')
    clock.tick(500)
    rec.mark('firstAudible')
    const t = rec.end('complete')
    expect(t!.input).toBe('typed')
    expect(t!.vadTailMs).toBeUndefined()
    expect(t!.sttMs).toBeUndefined()
    expect(t!.ttfwMs).toBe(3500)
  })

  it('marks are first-wins and ignored with no turn in flight', () => {
    const clock = makeClock()
    const rec = new TurnTimingsRecorder({ now: clock.now })
    rec.mark('firstToken') // no-op, nothing in flight
    expect(rec.current()).toBeNull()

    rec.begin('typed')
    clock.tick(100)
    rec.mark('firstToken')
    clock.tick(100)
    rec.mark('firstToken') // second token must not move the mark
    expect(rec.current()!.ttftMs).toBe(100)
  })

  it('a new begin() ends an in-flight record as aborted and keeps it in the log', () => {
    const clock = makeClock()
    const rec = new TurnTimingsRecorder({ now: clock.now })
    rec.begin('vad', { vadTailMs: 1400 })
    clock.tick(500)
    rec.begin('ptt') // barge-in
    const log = rec.log()
    expect(log).toHaveLength(1)
    expect(log[0].outcome).toBe('aborted')
    expect(rec.current()!.input).toBe('ptt')
    expect(rec.current()!.turn).toBe(2)
  })

  it('the log is a ring buffer capped at 20 turns', () => {
    const clock = makeClock()
    const rec = new TurnTimingsRecorder({ now: clock.now })
    for (let i = 0; i < 25; i++) {
      rec.begin('typed')
      rec.end('complete')
    }
    const log = rec.log()
    expect(log).toHaveLength(20)
    expect(log[0].turn).toBe(6)
    expect(log[19].turn).toBe(25)
  })

  it('end() without a turn in flight returns null', () => {
    const rec = new TurnTimingsRecorder({ now: () => 0 })
    expect(rec.end('complete')).toBeNull()
  })
})

describe('toLine', () => {
  it('emits one JSON line with integer ms and no undefined fields', () => {
    const t: TurnTimings = {
      v: 1,
      turn: 3,
      input: 'vad',
      startedAt: 123.4,
      vadTailMs: 1400,
      sttMs: 912.6,
      sttEngine: 'hosted',
      ttftMs: 8214.2,
      firstAudibleMs: 9050.5,
      ttfwMs: 10450.5,
      outcome: 'complete',
    }
    const parsed = JSON.parse(toLine(t))
    expect(parsed).toMatchObject({
      v: 1,
      turn: 3,
      input: 'vad',
      vadTailMs: 1400,
      sttMs: 913,
      sttEngine: 'hosted',
      ttftMs: 8214,
      firstAudibleMs: 9051,
      ttfwMs: 10451,
      outcome: 'complete',
    })
    expect('chatStartMs' in parsed).toBe(false)
    expect('startedAt' in parsed).toBe(false)
  })
})

describe('formatLatencyReadout', () => {
  it('formats present stages compactly and rounds to 0.1s', () => {
    const t: TurnTimings = {
      v: 1,
      turn: 1,
      input: 'vad',
      startedAt: 0,
      vadTailMs: 1400,
      sttMs: 912,
      ttftMs: 8214,
      firstSentenceMs: 8630,
      firstAudibleMs: 9050,
      ttfwMs: 10450,
      outcome: 'complete',
    }
    // TTS = firstAudible − firstSentence (the speak-start cost of the reply).
    expect(formatLatencyReadout(t)).toBe('VAD 1.4 · STT 0.9 · TTFT 8.2 · TTS 0.4 · TTFW 10.5s')
  })

  it('omits absent stages (typed turn: no VAD/STT)', () => {
    const t: TurnTimings = {
      v: 1,
      turn: 2,
      input: 'typed',
      startedAt: 0,
      ttftMs: 3050,
      firstSentenceMs: 3200,
      firstAudibleMs: 3500,
      ttfwMs: 3500,
      outcome: 'complete',
    }
    expect(formatLatencyReadout(t)).toBe('TTFT 3.1 · TTS 0.3 · TTFW 3.5s')
  })
})
