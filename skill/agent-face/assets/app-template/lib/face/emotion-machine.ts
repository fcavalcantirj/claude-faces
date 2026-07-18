// The conversation-lifecycle emotion state machine.
//
// This is the single source of truth for "what should the face feel right now?"
// The orchestrator pushes lifecycle phases (idle → listening → transcribing →
// waiting → streaming/speaking → idle) and model replies into it; the machine
// resolves an `Emotion` for the active FaceSkin to render.
//
// The reducer (`nextEmotion`) and the text helpers are PURE so they are unit
// testable headlessly. `createEmotionStore` layers a tiny observable store +
// transient-decay timing on top for React (`useEmotion`) / the orchestrator.

import { EMOTIONS, type Emotion } from '@/lib/face-points'

/**
 * Conversation lifecycle phases the orchestrator emits. Each maps to a resting
 * or expressive `Emotion` (see `nextEmotion`).
 */
export type LifecyclePhase =
  | 'idle' // nothing happening — rest on the resting emotion (neutral by default)
  | 'listening' // mic open, capturing user speech
  | 'transcribing' // running STT on captured audio
  | 'waiting' // request sent to the brain, awaiting first token
  | 'streaming' // tokens arriving from the brain
  | 'speaking' // TTS playing back the reply
  | 'clarifying' // the brain asked a clarifying question
  | 'error' // hard failure (transport/permission)
  | 'success' // an action completed happily
  | 'failure' // an action completed unhappily

/** Signals that refine phase resolution (e.g. the resting emotion after speaking). */
export interface EmotionSignals {
  /** The emotion to rest on when idle — set from a model directive or sentiment. */
  resting?: Emotion
}

const isEmotion = (value: string): value is Emotion =>
  (EMOTIONS as string[]).includes(value)

/**
 * Pure reducer: map a lifecycle phase (+ optional signals) to an `Emotion`.
 *
 *   idle                     → resting (neutral unless overridden)
 *   listening                → alert
 *   transcribing | waiting   → thinking
 *   streaming | speaking     → speaking
 *   clarifying               → confused
 *   error                    → glitch
 *   success                  → happy
 *   failure                  → sad
 */
export function nextEmotion(
  phase: LifecyclePhase,
  signals: EmotionSignals = {},
): Emotion {
  const resting = signals.resting ?? 'neutral'
  switch (phase) {
    case 'idle':
      return resting
    case 'listening':
      return 'alert'
    case 'transcribing':
    case 'waiting':
      return 'thinking'
    case 'streaming':
    case 'speaking':
      return 'speaking'
    case 'clarifying':
      return 'confused'
    case 'error':
      return 'glitch'
    case 'success':
      return 'happy'
    case 'failure':
      return 'sad'
    default:
      // Unknown phase: rest rather than crash.
      return resting
  }
}

// Matches a `[[face:happy]]` / `[[emotion:confused]]` directive anywhere in the
// reply. The emotion word is a single lowercase run; unknown words are stripped
// but yield a null emotion (so a hallucinated `[[face:banana]]` is harmless).
const FACE_DIRECTIVE_RE = /\[\[\s*(?:face|emotion)\s*:\s*([a-z]+)\s*\]\]/gi

export interface ParsedDirective {
  /** The resting emotion the model asked for, or null if none/invalid. */
  emotion: Emotion | null
  /** The reply text with every directive token removed and whitespace tidied. */
  text: string
}

/**
 * Extract a `[[face:<emotion>]]` directive from a reply and strip ALL directive
 * tokens from the text so they are never spoken aloud. The LAST valid directive
 * wins (a trailing directive is the documented resting-after-speaking form).
 */
export function parseFaceDirective(reply: string): ParsedDirective {
  let emotion: Emotion | null = null
  let match: RegExpExecArray | null
  FACE_DIRECTIVE_RE.lastIndex = 0
  while ((match = FACE_DIRECTIVE_RE.exec(reply)) !== null) {
    const word = match[1].toLowerCase()
    if (isEmotion(word)) emotion = word
  }
  const text = reply.replace(FACE_DIRECTIVE_RE, ' ').replace(/\s+/g, ' ').trim()
  return { emotion, text }
}

// Keyword → sentiment table (ported from EIDOLON's emotionFromReply). Ordered:
// first hit wins. Kept deliberately small and conservative.
const SENTIMENT_KEYWORDS: [RegExp, Emotion][] = [
  [/\b(error|failed|failure|exception|crash|cannot|can't|unable)\b/i, 'sad'],
  [/\b(warning|warn|careful|caution|attention|alert)\b/i, 'alert'],
  [/\b(clarify|clarification|unclear|not sure|do you mean|which one)\b/i, 'confused'],
  [/\b(success|succeeded|done|complete|completed|great|nice|congrat)\b/i, 'happy'],
]

/**
 * Keyword-sentiment fallback for when a reply carries no explicit directive.
 * Returns 'neutral' when nothing matches.
 */
export function emotionFromReply(reply: string): Emotion {
  for (const [re, emotion] of SENTIMENT_KEYWORDS) {
    if (re.test(reply)) return emotion
  }
  return 'neutral'
}

/**
 * Resolve the resting emotion for a reply: an explicit `[[face:…]]` directive
 * always wins; otherwise fall back to keyword sentiment. Also returns the spoken
 * text with any directive stripped.
 */
export function restingEmotionForReply(reply: string): {
  emotion: Emotion
  text: string
} {
  const { emotion, text } = parseFaceDirective(reply)
  return { emotion: emotion ?? emotionFromReply(text), text }
}

/**
 * Transient emotions are punchy reactions that should decay back to the resting
 * emotion after a hold window rather than sticking forever.
 */
export const TRANSIENT_EMOTIONS: ReadonlySet<Emotion> = new Set<Emotion>([
  'happy',
  'surprised',
])

export const isTransientEmotion = (e: Emotion): boolean =>
  TRANSIENT_EMOTIONS.has(e)

/** How long (ms) a transient emotion holds before settling to the resting one. */
export const TRANSIENT_HOLD_MS = 2200

/**
 * Emotions whose eyes aren't open circles (crescents, lids, hearts, static), so
 * the renderer suppresses blinking for them. Mirrors the `noBlink` set in
 * components/agent-face.tsx — kept here so the state machine stays consistent.
 */
export const BLINK_SUPPRESSED_EMOTIONS: ReadonlySet<Emotion> = new Set<Emotion>(
  ['happy', 'sleepy', 'love', 'glitch'],
)

export const isBlinkSuppressed = (e: Emotion): boolean =>
  BLINK_SUPPRESSED_EMOTIONS.has(e)

/** Injectable timer seam so the store's decay is testable with fake timers. */
export interface EmotionStoreOptions {
  holdMs?: number
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface EmotionStore {
  /** Current emotion the face should render. */
  getState(): Emotion
  /** The resting emotion the face settles onto when idle. */
  getResting(): Emotion
  /** Subscribe to changes; returns an unsubscribe fn (for useSyncExternalStore). */
  subscribe(listener: () => void): () => void
  /** Push a lifecycle phase; resolves + applies the next emotion. */
  setPhase(phase: LifecyclePhase): void
  /** Force a specific emotion (e.g. keyboard override in the HUD). */
  setEmotion(emotion: Emotion): void
  /** Set the resting emotion directly. */
  setResting(emotion: Emotion): void
  /**
   * Feed a model reply: parse its directive/sentiment to set the resting
   * emotion and return the spoken text with directives stripped.
   */
  applyReply(reply: string): string
}

/**
 * A tiny framework-free observable store the orchestrator updates and the
 * `useEmotion` hook subscribes to. Handles transient-emotion decay internally.
 */
export function createEmotionStore(
  options: EmotionStoreOptions = {},
): EmotionStore {
  const holdMs = options.holdMs ?? TRANSIENT_HOLD_MS
  const setTimer = options.setTimeoutFn ?? setTimeout
  const clearTimer = options.clearTimeoutFn ?? clearTimeout

  let emotion: Emotion = 'neutral'
  let resting: Emotion = 'neutral'
  let decayHandle: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()

  const emit = () => {
    for (const l of listeners) l()
  }

  const cancelDecay = () => {
    if (decayHandle !== null) {
      clearTimer(decayHandle)
      decayHandle = null
    }
  }

  const set = (next: Emotion) => {
    cancelDecay()
    if (next !== emotion) {
      emotion = next
      emit()
    }
    // Schedule decay for transient emotions (but never decay INTO themselves).
    if (isTransientEmotion(emotion) && emotion !== resting) {
      decayHandle = setTimer(() => {
        decayHandle = null
        if (emotion !== resting) {
          emotion = resting
          emit()
        }
      }, holdMs)
    }
  }

  return {
    getState: () => emotion,
    getResting: () => resting,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setPhase(phase) {
      set(nextEmotion(phase, { resting }))
    },
    setEmotion(next) {
      set(next)
    },
    setResting(next) {
      resting = next
    },
    applyReply(reply) {
      const { emotion: rest, text } = restingEmotionForReply(reply)
      resting = rest
      return text
    },
  }
}
