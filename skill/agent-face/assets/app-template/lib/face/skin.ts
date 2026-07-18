// The FaceSkin abstraction — the ONE seam every face renderer implements so the
// orchestrator drives emotion/mouth/viseme identically whether the face is the
// EIDOLON particle renderer or a TalkingHead/Ready-Player-Me avatar. The
// interface is imperative (mount/dispose) so it can wrap BOTH our React/R3F
// renderer (via a mounted root) and an imperative third-party lib like
// TalkingHead.js (`new TalkingHead(container)`) behind the same shape.
//
// This module is pure (types + selection logic + mood mapping) — no React /
// Three.js import — so it is unit-testable headlessly.

import type { Emotion } from '@/lib/face-points'
import type { VisemeScores } from '@/lib/face/visemes'

/** Known face skins. 'eidolon' is the default MVP renderer; 'talkinghead' is stretch. */
export type FaceSkinId = 'eidolon' | 'talkinghead'

export const FACE_SKIN_IDS: readonly FaceSkinId[] = ['eidolon', 'talkinghead']

export const DEFAULT_SKIN_ID: FaceSkinId = 'eidolon'

/**
 * A swappable face renderer. The orchestrator holds a FaceSkin and pushes
 * lifecycle updates through it; it never touches a concrete component.
 */
export interface FaceSkin {
  /** Which skin this is. */
  readonly id: FaceSkinId
  /** Set the resting/expressive emotion. */
  setEmotion(emotion: Emotion): void
  /** Toggle the audio-driven mouth on/off (independent of the 'speaking' emotion). */
  setSpeaking(on: boolean): void
  /** Set mouth openness 0..1 and, optionally, the dominant viseme label. */
  setMouth(open: number, viseme?: string): void
  /** Set per-viseme scores (blend-shape lip-sync); the skin derives its own shape. */
  setViseme(scores: VisemeScores): void
  /** Attach the renderer to a DOM container. May be async (lazy renderer load). */
  mount(container: HTMLElement): void | Promise<void>
  /** Tear down the renderer and release all resources. */
  dispose(): void
}

/** Plain, framework-free lifecycle state a skin controller tracks. */
export interface FaceSkinState {
  emotion: Emotion
  speaking: boolean
  mouth: { open: number; viseme: string }
}

export function createInitialState(): FaceSkinState {
  return { emotion: 'neutral', speaking: false, mouth: { open: 0, viseme: 'viseme_sil' } }
}

/**
 * Map an Emotion onto a TalkingHead.js mood (its built-in vocabulary:
 * neutral | happy | angry | sad | fear | disgust | love | sleep). Used by the
 * TalkingHead skin to steer avatar expression from our 12-emotion model.
 */
export const EMOTION_TO_TALKINGHEAD_MOOD: Record<Emotion, string> = {
  neutral: 'neutral',
  thinking: 'neutral',
  speaking: 'neutral',
  happy: 'happy',
  alert: 'neutral',
  sad: 'sad',
  angry: 'angry',
  surprised: 'fear',
  confused: 'neutral',
  sleepy: 'sleep',
  love: 'love',
  glitch: 'neutral',
}

export interface ResolveSkinOptions {
  /** Whether the TalkingHead library + a model are actually available. */
  talkingHeadAvailable?: boolean
  /** Injectable warn sink (defaults to console.warn) so tests can assert on it. */
  warn?: (message: string) => void
}

/**
 * Resolve a requested skin id to one we can actually render. Falls back to
 * EIDOLON (with a console warning) when 'talkinghead' is requested but its
 * library/model isn't present, or when the id is unknown — so a bad/stretch
 * selection degrades gracefully instead of crashing.
 */
export function resolveSkinId(
  requested: FaceSkinId | string | undefined | null,
  opts: ResolveSkinOptions = {},
): FaceSkinId {
  const warn = opts.warn ?? ((m: string) => console.warn(m))

  if (requested === 'eidolon' || requested == null) return 'eidolon'

  if (requested === 'talkinghead') {
    if (opts.talkingHeadAvailable) return 'talkinghead'
    warn(
      '[face-skin] TalkingHead skin unavailable (library/model not present); falling back to EIDOLON.',
    )
    return 'eidolon'
  }

  warn(`[face-skin] Unknown face skin "${requested}"; falling back to EIDOLON.`)
  return 'eidolon'
}
