'use client'

// TalkingHead / Ready-Player-Me skin — a STRETCH stub (explicitly scoped as such
// by the task): it implements the FaceSkin seam and carries the REAL mapping
// logic (Emotion -> TalkingHead mood, viseme scores -> ARKit/Oculus blendshapes)
// but does NOT bundle TalkingHead.js or a GLB avatar in the MVP. It must never
// block the core loop: mount() detects that the library/model isn't available
// and degrades gracefully (console warning + onUnavailable callback) so the host
// swaps in the EIDOLON skin instead of crashing.
//
// To turn this into a real skin later:
//   1. `npm i @met4citizen/talkinghead` and host a Ready Player Me `.glb`.
//   2. Set NEXT_PUBLIC_TALKINGHEAD_MODEL_URL (a public, non-secret asset URL).
//   3. In mount(): `const { TalkingHead } = await import(spec)`, then
//      `this.head = new TalkingHead(container, {...}); await head.showAvatar({ url })`.
//   4. Drive it: setEmotion -> head.setMood(EMOTION_TO_TALKINGHEAD_MOOD[e]),
//      setViseme -> head.setValues(visemeScoresToBlendshapes(scores, system)).

import type { Emotion } from '@/lib/face-points'
import {
  EMOTION_TO_TALKINGHEAD_MOOD,
  createInitialState,
  type FaceSkin,
  type FaceSkinState,
} from '@/lib/face/skin'
import {
  visemeScoresToBlendshapes,
  type BlendshapeSystem,
  type VisemeScores,
} from '@/lib/face/visemes'

/** Non-secret client env var pointing at a Ready Player Me GLB, if configured. */
function talkingHeadModelUrl(env: Record<string, string | undefined> = envRecord()): string | undefined {
  const url = env.NEXT_PUBLIC_TALKINGHEAD_MODEL_URL
  return url && url.trim() ? url.trim() : undefined
}

function envRecord(): Record<string, string | undefined> {
  // `process` may be undefined in some non-Node runtimes; guard defensively.
  return typeof process !== 'undefined' && process.env ? process.env : {}
}

/**
 * Whether the TalkingHead skin can actually render: it needs a configured model
 * URL. (The library itself is loaded lazily; without a model there is nothing to
 * show, so we treat it as unavailable and the selector falls back to EIDOLON.)
 */
export function isTalkingHeadAvailable(
  env: Record<string, string | undefined> = envRecord(),
): boolean {
  return Boolean(talkingHeadModelUrl(env))
}

export interface TalkingHeadSkinOptions {
  /** Override the model URL (else read from NEXT_PUBLIC_TALKINGHEAD_MODEL_URL). */
  modelUrl?: string
  /** Which blendshape set the loaded avatar exposes. */
  blendshapeSystem?: BlendshapeSystem
  /** Called when the skin cannot render (no lib/model) so the host can fall back. */
  onUnavailable?: () => void
}

class TalkingHeadSkin implements FaceSkin {
  readonly id = 'talkinghead' as const

  private state: FaceSkinState = createInitialState()
  private container: HTMLElement | null = null
  private lastBlendshapes: Record<string, number> = {}
  private readonly system: BlendshapeSystem

  constructor(private readonly opts: TalkingHeadSkinOptions = {}) {
    this.system = opts.blendshapeSystem ?? 'oculus'
  }

  setEmotion(emotion: Emotion): void {
    this.state.emotion = emotion
    // Real skin would: this.head?.setMood(EMOTION_TO_TALKINGHEAD_MOOD[emotion])
    void EMOTION_TO_TALKINGHEAD_MOOD[emotion]
  }

  setSpeaking(on: boolean): void {
    this.state.speaking = on
  }

  setMouth(open: number, viseme?: string): void {
    this.state.mouth.open = Number.isFinite(open) ? Math.min(1, Math.max(0, open)) : 0
    if (viseme) this.state.mouth.viseme = viseme
  }

  setViseme(scores: VisemeScores): void {
    // Real logic: compute morph-target weights the avatar understands.
    this.lastBlendshapes = visemeScoresToBlendshapes(scores, this.system)
    // Real skin would: this.head?.setValues(this.lastBlendshapes)
  }

  /** Exposed for tests/inspection: the last computed blendshape weight map. */
  getBlendshapes(): Record<string, number> {
    return this.lastBlendshapes
  }

  mount(container: HTMLElement): void {
    this.container = container
    const modelUrl = this.opts.modelUrl ?? talkingHeadModelUrl()
    if (!modelUrl) {
      console.warn(
        '[face-skin] TalkingHead skin is a stretch stub with no model configured; ' +
          'it will not render. Falling back to EIDOLON.',
      )
      this.opts.onUnavailable?.()
      return
    }
    // A model URL is set but the library isn't bundled in the MVP, so we still
    // cannot render. Signal unavailable rather than throwing.
    console.warn(
      '[face-skin] TalkingHead library is not bundled in this build (stretch feature); ' +
        'falling back to EIDOLON.',
    )
    this.opts.onUnavailable?.()
  }

  dispose(): void {
    this.container = null
    this.lastBlendshapes = {}
  }
}

export function createTalkingHeadSkin(opts: TalkingHeadSkinOptions = {}): FaceSkin {
  return new TalkingHeadSkin(opts)
}
