'use client'

// React binding for the conversation orchestrator — the ONE hook the page uses
// to get a fully-wired, running voice+face pipeline. It constructs the REAL
// subsystems once (a shared mouthRef, a `TtsRouter`, the STT `transcribe` seam,
// the streaming `runChat` driver, the mic recorder + push-to-talk, and the
// hands-free VAD), stitches them into a `ConversationOrchestrator`, and exposes:
//
//   • `status`      — the live FSM status (phase, speaking, STT engine, error).
//   • `attachSkin`  — hand the mounted FaceSkin to the orchestrator to drive.
//   • push-to-talk  — pointer + Space handlers (active only in PTT input mode).
//   • hands-free    — start/stop continuous VAD listening.
//   • `sendText`    — run a turn from typed text (skips STT).
//   • `interrupt`   — global barge-in (abort chat + stop TTS).
//
// All the browser-heavy wiring lives here so the page stays a thin shell and the
// orchestrator core stays headlessly testable (see lib/orchestrator.test.ts).

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { getConversationStore } from '@/lib/use-conversation'
import { getEmotionStore } from '@/lib/face/use-emotion'
import {
  createOrchestrator,
  type ConversationOrchestrator,
  type OrchestratorStatus,
} from '@/lib/orchestrator'
import { createTtsRouter } from '@/lib/tts'
import { transcribe } from '@/lib/stt'
import { runChat } from '@/lib/chat/client'
import { createRecorder } from '@/lib/audio/recorder'
import { createPushToTalk, type PushToTalkController } from '@/lib/audio/push-to-talk'
import { createVad, type VadController } from '@/lib/audio/vad'
import type { MouthState } from '@/components/agent-face'
import type { FaceSkin } from '@/lib/face/skin'

interface OrchestratorRig {
  orchestrator: ConversationOrchestrator
  ptt: PushToTalkController
  vad: VadController
  dispose(): void
}

/** Build the whole real rig once (client-only). */
function buildRig(): OrchestratorRig {
  const conversation = getConversationStore()
  const emotion = getEmotionStore()

  // The shared mouth buffer: the TTS router writes real/estimated features into
  // it; the orchestrator bridges them into the mounted FaceSkin each frame.
  const mouthRef: { current: MouthState | null } = {
    current: { open: 0, viseme: 'viseme_sil' },
  }

  // The router's lifecycle callbacks reference the orchestrator lazily (it is
  // built just after) so the SPEAKING handoff is driven by real audio.
  const orchRef: { current: ConversationOrchestrator | null } = { current: null }

  const tts = createTtsRouter(
    { mouthRef, defaultEngine: conversation.getState().settings.ttsEngine },
    {
      onStart: () => orchRef.current?.handleSpeechStart(),
      onEnd: () => orchRef.current?.handleSpeechEnd(),
      onError: (err) => orchRef.current?.handleSpeechError(err),
    },
  )

  const recorder = createRecorder({
    // An auto-stopped clip (size/duration guard) still runs a turn.
    onResult: (blob) => void orchRef.current?.submitAudio(blob),
  })

  const ptt = createPushToTalk({
    recorder,
    onResult: (blob) => void orchRef.current?.submitAudio(blob),
    onError: (err) => console.warn('[push-to-talk]', err),
  })

  // HALF-DUPLEX: the VAD suppresses itself while the face speaks (see
  // lib/audio/vad.ts) — echo of the reply must never reach submitAudio.
  // Interrupting mid-reply is a UI action (Esc / STOP / the talk controls).
  const vad = createVad({
    onSpeechEnd: (segment) => void orchRef.current?.submitAudio(segment.blob),
    onError: (err) => console.warn('[vad]', err),
  })

  const orchestrator = createOrchestrator({
    conversation,
    emotion,
    tts,
    transcribe: (blob, opts) => transcribe(blob, opts),
    runChat,
    mouthRef,
    // Let the VAD know when the face is speaking so it can classify barge-in.
    onFaceSpeakingChange: (speaking) => vad.setFaceSpeaking(speaking),
    raf:
      typeof requestAnimationFrame !== 'undefined'
        ? (cb) => requestAnimationFrame(cb)
        : undefined,
    caf:
      typeof cancelAnimationFrame !== 'undefined'
        ? (id) => cancelAnimationFrame(id)
        : undefined,
  })
  orchRef.current = orchestrator

  return {
    orchestrator,
    ptt,
    vad,
    dispose() {
      orchestrator.dispose()
      tts.dispose()
      recorder.dispose()
      void vad.destroy()
    },
  }
}

export interface UseOrchestrator {
  /** The live FSM status (phase, speaking, STT engine, error). */
  status: OrchestratorStatus
  /** Whether hands-free VAD is the active input mode. */
  handsFree: boolean
  /** True while hands-free listening is engaged. */
  listening: boolean
  /** Hand the mounted FaceSkin to the orchestrator so it can drive the face. */
  attachSkin(skin: FaceSkin | null): void
  /** Press-and-hold handlers for the on-screen Talk button (PTT mode). */
  pttHandlers: {
    onPointerDown(e?: { preventDefault?: () => void }): void
    onPointerUp(e?: { preventDefault?: () => void }): void
    onPointerLeave(e?: { preventDefault?: () => void }): void
  }
  /** Start/stop hands-free VAD listening (must be called from a user gesture). */
  toggleHandsFree(): void
  /** Run a turn from typed text (skips STT). */
  sendText(text: string): void
  /** Global barge-in: abort the in-flight chat and stop queued TTS. */
  interrupt(): void
}

/**
 * Subscribe to a fully-wired orchestrator rig. Constructs the real pipeline once
 * (mic, VAD, STT, chat, TTS) and re-renders on FSM status changes.
 */
export function useOrchestrator(): UseOrchestrator {
  // Lazy STATE, not a lazily-initialized ref: the rig is legitimately used
  // DURING render (useSyncExternalStore subscribes to it, the memoized handlers
  // close over it), and render-time ref reads are not stable under concurrent
  // rendering. useState is the sanctioned render-safe home for a create-once
  // instance. Known cost: dev-only StrictMode double-invokes the initializer,
  // building one discarded rig whose only live side effect is an inert
  // emotion-store subscription (its faceSkin stays null; mic/VAD/workers are
  // only acquired in start()/init(), which the discarded copy never reaches).
  const [rig] = useState(buildRig)

  const conversation = getConversationStore()
  const inputMode = useSyncExternalStore(
    conversation.subscribe,
    () => conversation.getState().settings.inputMode,
    // Server/hydration snapshot: the default, never the persisted mode (a
    // hands-free user would otherwise hydrate-mismatch the talk controls).
    () => conversation.getServerState().settings.inputMode,
  )
  const handsFree = inputMode === 'hands-free'

  const status = useSyncExternalStore(
    (cb) => rig.orchestrator.subscribe(cb),
    () => rig.orchestrator.getStatus(),
    () => rig.orchestrator.getStatus(),
  )

  // Hands-free listening is a simple engaged/paused flag for the Talk button.
  const [listening, setListening] = useState(false)

  // Push-to-talk: hold Space to record (ignored while typing / on repeat).
  useEffect(() => {
    if (handsFree) return
    const onKeyDown = (e: KeyboardEvent) => rig.ptt.onKeyDown(e)
    const onKeyUp = (e: KeyboardEvent) => rig.ptt.onKeyUp(e)
    const onBlur = () => rig.ptt.cancel()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [rig, handsFree])

  // Leaving hands-free mode stops any active listening. The input-mode change
  // is an external-store event, so react to it in the subscription callback
  // (where setState is sanctioned) instead of a cascading effect.
  useEffect(() => {
    let prev = conversation.getState().settings.inputMode
    return conversation.subscribe(() => {
      const mode = conversation.getState().settings.inputMode
      if (mode === prev) return
      prev = mode
      if (mode !== 'hands-free') {
        void rig.vad.pause() // idempotent when already idle
        setListening(false)
      }
    })
  }, [conversation, rig])

  // Escape = global barge-in.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') rig.orchestrator.interrupt()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rig])

  const attachSkin = useCallback(
    (skin: FaceSkin | null) => rig.orchestrator.attachFaceSkin(skin),
    [rig],
  )

  const pttHandlers = useMemo(
    () => ({
      onPointerDown: (e?: { preventDefault?: () => void }) => rig.ptt.onPointerDown(e),
      onPointerUp: (e?: { preventDefault?: () => void }) => rig.ptt.onPointerUp(e),
      onPointerLeave: (e?: { preventDefault?: () => void }) => rig.ptt.onPointerUp(e),
    }),
    [rig],
  )

  const toggleHandsFree = useCallback(() => {
    setListening((wasListening) => {
      if (wasListening) {
        void rig.vad.pause()
        return false
      }
      void rig.vad.start().catch((err) => console.warn('[vad] start failed', err))
      return true
    })
  }, [rig])

  const sendText = useCallback(
    (text: string) => rig.orchestrator.submitText(text),
    [rig],
  )
  const interrupt = useCallback(() => rig.orchestrator.interrupt(), [rig])

  return {
    status,
    handsFree,
    listening,
    attachSkin,
    pttHandlers,
    toggleHandsFree,
    sendText,
    interrupt,
  }
}
