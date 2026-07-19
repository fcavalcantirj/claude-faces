'use client'

// EIDOLON skin — the default MVP renderer, wrapping the existing R3F particle
// face (components/agent-face.tsx) behind the imperative FaceSkin interface.
//
// The heavy renderer (Three.js / R3F / the AgentFace component) is loaded lazily
// inside mount() via dynamic import, so merely constructing the controller and
// pushing setEmotion/setMouth/setViseme updates is cheap and framework-free
// (importable in a headless test without pulling WebGL). mount() spins up a
// dedicated React root in the container; setters drive it via a ref-based mouth
// buffer (no re-render on the 60fps loop) and a tiny emotion/speaking listener.

import { createElement, type RefObject } from 'react'
import type { Emotion } from '@/lib/face-points'
import {
  SILENCE_VISEME,
  dominantViseme,
  type VisemeScores,
} from '@/lib/face/visemes'
import {
  createInitialState,
  type FaceSkin,
  type FaceSkinState,
} from '@/lib/face/skin'
import type { MouthState } from '@/components/agent-face'

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Callbacks the mounted view registers so imperative updates reach React state. */
export interface EidolonViewBindings {
  onEmotion: (emotion: Emotion) => void
  onSpeaking: (on: boolean) => void
}

/** The contract the lazy-loaded view needs from the controller (no React import). */
export interface EidolonSkinDriver {
  /** Live mouth buffer the R3F useFrame loop reads each frame (no re-render). */
  readonly mouthRef: RefObject<MouthState>
  /** Current lifecycle state, for the view's initial props. */
  getState(): FaceSkinState
  /** Register view callbacks; returns an unbind function for effect cleanup. */
  bindView(bindings: EidolonViewBindings): () => void
}

type ReactRoot = { render(children: ReturnType<typeof createElement>): void; unmount(): void }

class EidolonSkin implements FaceSkin, EidolonSkinDriver {
  readonly id = 'eidolon' as const
  readonly mouthRef: RefObject<MouthState> = {
    current: { open: 0, viseme: SILENCE_VISEME },
  }

  private state = createInitialState()
  private bindings: EidolonViewBindings | null = null
  private root: ReactRoot | null = null
  /** The container we anchored a root on (see RootHost note in mount()). */
  private host: RootHost | null = null
  /** Set by dispose(); a mount still awaiting its imports must then create nothing. */
  private torn = false

  setEmotion(emotion: Emotion): void {
    this.state.emotion = emotion
    this.bindings?.onEmotion(emotion)
  }

  setSpeaking(on: boolean): void {
    this.state.speaking = on
    this.bindings?.onSpeaking(on)
  }

  setMouth(open: number, viseme?: string): void {
    const o = clamp01(open)
    this.mouthRef.current.open = o
    this.state.mouth.open = o
    if (viseme) {
      this.mouthRef.current.viseme = viseme
      this.state.mouth.viseme = viseme
    }
  }

  setViseme(scores: VisemeScores): void {
    const viseme = dominantViseme(scores)
    this.mouthRef.current.viseme = viseme
    this.state.mouth.viseme = viseme
  }

  getState(): FaceSkinState {
    return this.state
  }

  bindView(bindings: EidolonViewBindings): () => void {
    this.bindings = bindings
    return () => {
      if (this.bindings === bindings) this.bindings = null
    }
  }

  async mount(container: HTMLElement): Promise<void> {
    const [{ createRoot }, { EidolonSkinView }] = await Promise.all([
      import('react-dom/client'),
      import('./eidolon-skin-view'),
    ])
    // The owning effect may have cleaned up WHILE those imports were in flight
    // (StrictMode remount, skin switch, HMR). dispose() then found root===null
    // and unmounted nothing — so creating a root here would orphan it on a
    // container a newer skin is about to claim, and the next mount would log
    // React's "already been passed to createRoot()" (hit live, 2026-07-19).
    if (this.torn) return
    // Anchor the root ON THE CONTAINER, not just on this instance: a new skin
    // object (fresh effect run, HMR-swapped module) must render into the
    // existing root — React's own advice — rather than createRoot() a second
    // time on the same node. The property survives instance and module churn.
    const host = container as RootHost
    const root = host.__agentFaceRoot ?? createRoot(container)
    host.__agentFaceRoot = root
    this.host = host
    this.root = root
    root.render(createElement(EidolonSkinView, { driver: this }))
    this.exposeE2EHook()
  }

  /**
   * Opt-in E2E hook: with `?e2e=1` in the URL, expose the live mouth buffer so a
   * browser test can prove the mouth tracks REAL audio rather than a fixed sine.
   * Read-only and gated on the query param, so a normal session never sees it.
   */
  private exposeE2EHook(): void {
    if (typeof window === 'undefined') return
    if (!new URLSearchParams(window.location.search).has('e2e')) return
    ;(window as unknown as { __agentFaceMouth?: () => MouthState }).__agentFaceMouth = () => ({
      ...this.mouthRef.current,
    })
  }

  dispose(): void {
    this.torn = true
    this.bindings = null
    if (this.root) {
      this.root.unmount()
      // Free the container for a genuinely fresh root next mount.
      if (this.host && this.host.__agentFaceRoot === this.root) {
        delete this.host.__agentFaceRoot
      }
      this.root = null
      this.host = null
    }
  }
}

/** A container element carrying the root anchored on it (survives HMR/instances). */
type RootHost = HTMLElement & { __agentFaceRoot?: ReactRoot }

export function createEidolonSkin(): FaceSkin {
  return new EidolonSkin()
}
