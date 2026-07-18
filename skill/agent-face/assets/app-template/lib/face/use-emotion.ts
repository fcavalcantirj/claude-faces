// React binding for the emotion state machine.
//
// `useEmotion()` gives a component the current `Emotion` from a shared store and
// stable action callbacks the orchestrator uses to drive it. The store lives
// outside React (a module-level singleton by default) so the orchestrator can
// push lifecycle phases from event handlers/effects and every subscriber (the
// FaceSkin host, the HUD) re-renders via `useSyncExternalStore`.

'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Emotion } from '@/lib/face-points'
import {
  createEmotionStore,
  type EmotionStore,
  type LifecyclePhase,
} from '@/lib/face/emotion-machine'

// Process-wide default store so the whole app shares one face state without a
// provider. Tests / embeds can inject their own store into `useEmotion`.
let defaultStore: EmotionStore | null = null

export function getEmotionStore(): EmotionStore {
  if (!defaultStore) defaultStore = createEmotionStore()
  return defaultStore
}

export interface UseEmotion {
  /** The emotion the face should render right now. */
  emotion: Emotion
  /** The resting emotion the face settles onto when idle. */
  resting: Emotion
  /** Push a lifecycle phase (idle/listening/…). */
  setPhase(phase: LifecyclePhase): void
  /** Force a specific emotion (HUD keyboard override). */
  setEmotion(emotion: Emotion): void
  /** Feed a model reply: returns the spoken text with `[[face:…]]` stripped. */
  applyReply(reply: string): string
  /** The underlying store, for imperative access outside render. */
  store: EmotionStore
}

/**
 * Subscribe to the shared (or an injected) emotion store.
 */
export function useEmotion(store: EmotionStore = getEmotionStore()): UseEmotion {
  const emotion = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  )
  const resting = useSyncExternalStore(
    store.subscribe,
    store.getResting,
    store.getResting,
  )

  const setPhase = useCallback(
    (phase: LifecyclePhase) => store.setPhase(phase),
    [store],
  )
  const setEmotion = useCallback(
    (e: Emotion) => store.setEmotion(e),
    [store],
  )
  const applyReply = useCallback((reply: string) => store.applyReply(reply), [
    store,
  ])

  return useMemo(
    () => ({ emotion, resting, setPhase, setEmotion, applyReply, store }),
    [emotion, resting, setPhase, setEmotion, applyReply, store],
  )
}
