import { describe, it, expect, vi } from 'vitest'
import {
  nextEmotion,
  parseFaceDirective,
  emotionFromReply,
  restingEmotionForReply,
  isTransientEmotion,
  isBlinkSuppressed,
  BLINK_SUPPRESSED_EMOTIONS,
  TRANSIENT_HOLD_MS,
  createEmotionStore,
  type LifecyclePhase,
} from '@/lib/face/emotion-machine'

describe('nextEmotion — lifecycle → Emotion mapping', () => {
  const cases: [LifecyclePhase, string][] = [
    ['idle', 'neutral'],
    ['listening', 'alert'],
    ['transcribing', 'thinking'],
    ['waiting', 'thinking'],
    ['streaming', 'speaking'],
    ['speaking', 'speaking'],
    ['clarifying', 'confused'],
    ['error', 'glitch'],
    ['success', 'happy'],
    ['failure', 'sad'],
  ]
  it.each(cases)('phase %s → %s', (phase, expected) => {
    expect(nextEmotion(phase)).toBe(expected)
  })

  it('idle resolves to the resting emotion when one is supplied', () => {
    expect(nextEmotion('idle', { resting: 'love' })).toBe('love')
    // absent resting defaults to neutral
    expect(nextEmotion('idle')).toBe('neutral')
  })

  it('unknown phase falls back to the resting emotion', () => {
    // @ts-expect-error deliberately invalid phase
    expect(nextEmotion('bogus', { resting: 'sad' })).toBe('sad')
  })
})

describe('parseFaceDirective — [[face:<emotion>]] override', () => {
  it('strips a trailing directive and returns the resting emotion', () => {
    const r = parseFaceDirective('All done here! [[face:happy]]')
    expect(r.emotion).toBe('happy')
    expect(r.text).toBe('All done here!')
  })

  it('accepts the "emotion" keyword too', () => {
    expect(parseFaceDirective('hmm [[emotion:confused]]').emotion).toBe('confused')
  })

  it('ignores unknown / invalid emotion words but still strips the token', () => {
    const r = parseFaceDirective('weird [[face:banana]]')
    expect(r.emotion).toBeNull()
    expect(r.text).toBe('weird')
  })

  it('returns null emotion and untouched text when no directive present', () => {
    const r = parseFaceDirective('just talking')
    expect(r.emotion).toBeNull()
    expect(r.text).toBe('just talking')
  })

  it('strips a directive even when tokens appear mid-text, keeping surrounding words', () => {
    const r = parseFaceDirective('one [[face:sad]] two')
    expect(r.emotion).toBe('sad')
    expect(r.text).toBe('one two')
  })
})

describe('emotionFromReply — keyword sentiment fallback', () => {
  it.each([
    ['Something went wrong: error occurred', 'sad'],
    ['warning: low battery', 'alert'],
    ['let me clarify what you meant', 'confused'],
    ['success! deploy finished', 'happy'],
    ['a perfectly ordinary sentence', 'neutral'],
  ] as const)('%s → %s', (text, expected) => {
    expect(emotionFromReply(text)).toBe(expected)
  })
})

describe('restingEmotionForReply — directive wins over sentiment', () => {
  it('uses the directive and strips it from the spoken text', () => {
    const r = restingEmotionForReply('everything failed [[face:happy]]')
    expect(r.emotion).toBe('happy') // directive overrides the "failed" keyword
    expect(r.text).toBe('everything failed')
  })

  it('falls back to sentiment when no directive is present', () => {
    const r = restingEmotionForReply('an error was thrown')
    expect(r.emotion).toBe('sad')
    expect(r.text).toBe('an error was thrown')
  })
})

describe('transient + blink-suppression metadata', () => {
  it('happy and surprised are transient', () => {
    expect(isTransientEmotion('happy')).toBe(true)
    expect(isTransientEmotion('surprised')).toBe(true)
    expect(isTransientEmotion('neutral')).toBe(false)
  })

  it('blink-suppressed set matches the renderer (happy/sleepy/love/glitch)', () => {
    expect([...BLINK_SUPPRESSED_EMOTIONS].sort()).toEqual(
      ['glitch', 'happy', 'love', 'sleepy'],
    )
    expect(isBlinkSuppressed('love')).toBe(true)
    expect(isBlinkSuppressed('neutral')).toBe(false)
  })
})

describe('createEmotionStore — orchestrator-facing store', () => {
  it('drives a reply-ending-in-directive through speaking → resting happy', () => {
    const store = createEmotionStore()
    // model reply carries a trailing directive
    const spoken = store.applyReply('Deploy is green [[face:happy]]')
    expect(spoken).toBe('Deploy is green') // directive stripped from spoken output
    expect(store.getResting()).toBe('happy')

    store.setPhase('speaking')
    expect(store.getState()).toBe('speaking')

    // when speaking ends the face settles onto the directive-chosen resting emotion
    store.setPhase('idle')
    expect(store.getState()).toBe('happy')
  })

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const store = createEmotionStore()
    const seen: string[] = []
    const unsub = store.subscribe(() => seen.push(store.getState()))
    store.setPhase('listening')
    store.setPhase('idle')
    unsub()
    store.setPhase('error')
    expect(seen).toEqual(['alert', 'neutral'])
  })

  it('setEmotion overrides the phase-derived state and notifies subscribers', () => {
    const store = createEmotionStore()
    const seen: string[] = []
    const unsub = store.subscribe(() => seen.push(store.getState()))
    store.setEmotion('love')
    expect(store.getState()).toBe('love')
    expect(seen).toEqual(['love'])
    unsub()
  })

  it('decays a transient emotion back to resting after the hold window', () => {
    vi.useFakeTimers()
    try {
      const store = createEmotionStore()
      store.applyReply('all good [[face:love]]')
      store.setPhase('success') // → transient happy
      expect(store.getState()).toBe('happy')
      vi.advanceTimersByTime(TRANSIENT_HOLD_MS + 10)
      expect(store.getState()).toBe('love') // settled onto resting
    } finally {
      vi.useRealTimers()
    }
  })
})
