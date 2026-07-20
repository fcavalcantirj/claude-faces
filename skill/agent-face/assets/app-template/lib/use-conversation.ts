// React binding for the conversation store.
//
// `useConversation()` subscribes a component to the shared transcript + settings
// and returns stable action callbacks (add a user turn, stream assistant deltas,
// pick a provider/model, reset). The store lives outside React (a module-level
// singleton by default, same idiom as `useEmotion`) so the chat client can mutate
// it from async handlers and every subscriber re-renders via `useSyncExternalStore`.

'use client'

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ChatMessage } from '@/lib/providers'
import {
  createConversationStore,
  type ConversationState,
  type ConversationStore,
  type ConversationTurn,
  type InputMode,
  type SttLanguage,
} from '@/lib/conversation'
import type { SttMode } from '@/lib/stt'
import type { TtsEngine } from '@/lib/tts'
import type { FaceSkinId } from '@/lib/face/skin'

// Process-wide default store so the whole app shares one transcript without a
// provider component. Tests / embeds can inject their own store into the hook.
let defaultStore: ConversationStore | null = null

export function getConversationStore(): ConversationStore {
  if (!defaultStore) defaultStore = createConversationStore()
  return defaultStore
}

export interface UseConversation {
  /** The full transcript + settings + system prompt. */
  state: ConversationState
  /** Convenience: the ordered turns. */
  turns: ConversationTurn[]
  /** Record a user turn. */
  addUserTurn(content: string): void
  /** Append a streamed assistant token (opens a pending turn if needed). */
  appendAssistantDelta(delta: string): void
  /** Finalize the streaming assistant turn (optionally replace with spoken text). */
  finalizeAssistantTurn(finalText?: string): void
  /** Select the brain. */
  setProvider(provider: string | null): void
  /** Select the model. */
  setModel(model: string | null): void
  /** Choose push-to-talk vs hands-free VAD (mutually exclusive). */
  setInputMode(mode: InputMode): void
  /** Choose the speech-to-text path (browser | hosted | auto). */
  setSttMode(mode: SttMode): void
  /** Pin the transcription language (auto = per-clip detection). */
  setSttLanguage(language: SttLanguage): void
  /** Choose the voice-out engine (web-speech | openai | kokoro). */
  setTtsEngine(engine: TtsEngine): void
  /** Choose the face renderer skin (eidolon | talkinghead). */
  setFaceSkin(skin: FaceSkinId): void
  /** Set the persona / system prompt. */
  setSystem(system: string): void
  /** Clear the transcript (keeps provider/model + persona). */
  reset(): void
  /** Build the `/api/chat` messages array from the current transcript. */
  toMessages(): ChatMessage[]
  /** The underlying store, for imperative access outside render. */
  store: ConversationStore
}

/** Subscribe to the shared (or an injected) conversation store. */
export function useConversation(
  store: ConversationStore = getConversationStore(),
): UseConversation {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    // Hydration-safe by construction: the server snapshot is the pristine
    // default, so the client's hydration render matches the server HTML even
    // when localStorage holds a restored conversation (React #418 on any
    // state-carrying browser otherwise — found on the Pi deployment).
    store.getServerState,
  )

  const addUserTurn = useCallback(
    (content: string) => void store.addUserTurn(content),
    [store],
  )
  const appendAssistantDelta = useCallback(
    (delta: string) => void store.appendAssistantDelta(delta),
    [store],
  )
  const finalizeAssistantTurn = useCallback(
    (finalText?: string) => void store.finalizeAssistantTurn(finalText),
    [store],
  )
  const setProvider = useCallback(
    (provider: string | null) => store.setProvider(provider),
    [store],
  )
  const setModel = useCallback(
    (model: string | null) => store.setModel(model),
    [store],
  )
  const setInputMode = useCallback(
    (mode: InputMode) => store.setInputMode(mode),
    [store],
  )
  const setSttMode = useCallback((mode: SttMode) => store.setSttMode(mode), [store])
  const setSttLanguage = useCallback(
    (language: SttLanguage) => store.setSttLanguage(language),
    [store],
  )
  const setTtsEngine = useCallback(
    (engine: TtsEngine) => store.setTtsEngine(engine),
    [store],
  )
  const setFaceSkin = useCallback(
    (skin: FaceSkinId) => store.setFaceSkin(skin),
    [store],
  )
  const setSystem = useCallback((system: string) => store.setSystem(system), [store])
  const reset = useCallback(() => store.reset(), [store])
  const toMessages = useCallback(() => store.toMessages(), [store])

  return useMemo(
    () => ({
      state,
      turns: state.turns,
      addUserTurn,
      appendAssistantDelta,
      finalizeAssistantTurn,
      setProvider,
      setModel,
      setInputMode,
      setSttMode,
      setSttLanguage,
      setTtsEngine,
      setFaceSkin,
      setSystem,
      reset,
      toMessages,
      store,
    }),
    [
      state,
      addUserTurn,
      appendAssistantDelta,
      finalizeAssistantTurn,
      setProvider,
      setModel,
      setInputMode,
      setSttMode,
      setSttLanguage,
      setTtsEngine,
      setFaceSkin,
      setSystem,
      reset,
      toMessages,
      store,
    ],
  )
}
