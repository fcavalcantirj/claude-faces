// The conversation orchestrator — the single object that owns the end-to-end
// spoken-turn lifecycle and sequences every subsystem behind one seam:
//
//   capture (PTT or VAD) → transcribe(blob, mode) → streamChat → chunked speak
//   → lip-sync → emotion transitions
//
// It is deliberately framework-free and fully injectable so the WHOLE pipeline
// is headlessly testable with fakes (no mic, no network, no audio, no WebGL):
// the React layer wires the real recorder/VAD, the real `transcribe`, the real
// `runChat`, and a real `TtsRouter`; a test wires trivial fakes and drives a
// complete turn — including barge-in — by hand.
//
// Responsibilities:
//   • Own the lifecycle FSM (idle → transcribing → waiting → speaking → idle)
//     and expose it (getPhase/subscribe) for the HUD.
//   • Push each phase into the shared EmotionStore, and mirror the resolved
//     emotion + speaking flag + live mouth features into the active FaceSkin —
//     so the face shows THINKING during the stream and SPEAKING synced to the
//     real audio (never before it).
//   • Start TTS on the FIRST streamed sentence (low latency), keep the transcript
//     updating live, and strip `[[face:x]]` before speaking (applying it as the
//     resting emotion).
//   • Implement global barge-in: a new utterance (or VAD-during-speech) aborts
//     the in-flight chat AND stops queued TTS, then cleanly starts a new turn.
//   • Keep the 60fps particle loop safe: heavy state lives in refs/stores, and
//     the mouth is bridged from the TTS mouthRef to the skin via a single rAF
//     copy loop that only runs while speaking.

import type { ConversationStore } from '@/lib/conversation'
import type {
  EmotionStore,
  LifecyclePhase,
} from '@/lib/face/emotion-machine'
import type { SttMode, SttResult } from '@/lib/stt'
import type {
  ChatDriverCallbacks,
  ChatSession,
  RunChatOptions,
} from '@/lib/chat/client'
import type { TtsEngine } from '@/lib/tts'
import type { FaceSkin } from '@/lib/face/skin'
import type { MouthState } from '@/components/agent-face'
import { AdapterError } from '@/lib/providers'

/** The TTS surface the orchestrator drives (satisfied by `TtsRouter`). */
export interface OrchestratorTts {
  /** Queue text (sentence-chunked) and start speaking on the first sentence. */
  speak(text: string, opts?: { engine?: TtsEngine }): void
  /** Barge-in: stop all speech immediately (no `onEnd`). */
  stop(): void
}

/** Transcribe a captured clip (the STT auto-selection seam). */
export type TranscribeFn = (
  blob: Blob,
  opts: { mode?: SttMode; language?: string; signal?: AbortSignal },
) => Promise<SttResult>

/** Drive one streamed chat turn (the chat-client seam). */
export type RunChatFn = (
  opts: RunChatOptions,
  callbacks: ChatDriverCallbacks,
) => ChatSession

/** A short, human-readable status the HUD can surface. */
export interface OrchestratorStatus {
  /** The active lifecycle phase. */
  phase: LifecyclePhase
  /** True between the first spoken sentence and the queue draining. */
  speaking: boolean
  /** The engine that served the last transcript (browser | hosted). */
  sttEngine?: SttResult['engine']
  /** Execution backend when `sttEngine === 'browser'`. */
  sttBackend?: SttResult['backend']
  /** The last transcript text (for the transcript panel). */
  lastTranscript?: string
  /** A user-facing error message from the most recent failed step. */
  error?: string
}

export interface OrchestratorDeps {
  /** Transcript + selected provider/model/engine settings (the source of truth). */
  conversation: ConversationStore
  /** Lifecycle → emotion resolution (+ transient decay). */
  emotion: EmotionStore
  /** The voice-out router (speak/stop). */
  tts: OrchestratorTts
  /** STT auto-selection. */
  transcribe: TranscribeFn
  /** The streaming chat driver. */
  runChat: RunChatFn
  /** Face renderer to drive (emotion/speaking/mouth). Optional (set later). */
  faceSkin?: FaceSkin | null
  /**
   * The mouth ref the TTS router writes each frame. When both this and a
   * faceSkin are present, a rAF loop bridges it into `faceSkin.setMouth` while
   * speaking so the third-party skin path also lip-syncs.
   */
  mouthRef?: { current: MouthState | null }
  /** Called when the FACE starts/stops speaking (wire to `VadController.setFaceSpeaking`). */
  onFaceSpeakingChange?: (speaking: boolean) => void
  /** BCP-47 language hint passed to STT. */
  language?: string
  /** rAF/caf for the mouth bridge (default the globals; omitted → no bridge). */
  raf?: (cb: (t: number) => void) => number
  caf?: (id: number) => void
  /** Non-fatal warning sink (default console.warn). */
  warn?: (msg: string) => void
}

/**
 * The conversation orchestrator. Construct once (see {@link createOrchestrator}),
 * attach a FaceSkin when it mounts, then feed it captured clips (`submitAudio`)
 * or typed text (`submitText`); it runs the full turn and drives the face.
 */
export class ConversationOrchestrator {
  private readonly deps: OrchestratorDeps

  private phase: LifecyclePhase = 'idle'
  private speaking = false
  private status: OrchestratorStatus = { phase: 'idle', speaking: false }

  /** The in-flight chat turn, if any (for barge-in). */
  private session: ChatSession | null = null
  /** The STT abort controller, if a transcription is in flight. */
  private sttAbort: AbortController | null = null
  private faceSkin: FaceSkin | null = null
  private frameId: number | null = null
  private disposed = false
  private unsubEmotion: (() => void) | null = null

  private readonly listeners = new Set<() => void>()

  constructor(deps: OrchestratorDeps) {
    this.deps = deps
    this.faceSkin = deps.faceSkin ?? null
    // Mirror every emotion-store change (phase-driven OR a HUD override) into the
    // active skin, so one subscription keeps the face in lockstep with the FSM.
    this.unsubEmotion = deps.emotion.subscribe(() => {
      this.faceSkin?.setEmotion(deps.emotion.getState())
    })
  }

  // --- observation ---------------------------------------------------------

  getPhase(): LifecyclePhase {
    return this.phase
  }

  getStatus(): OrchestratorStatus {
    return this.status
  }

  /** True while a turn is being spoken aloud. */
  isSpeaking(): boolean {
    return this.speaking
  }

  /** True while a turn is being transcribed / answered / spoken (not idle). */
  isBusy(): boolean {
    return this.phase !== 'idle' || this.session !== null || this.speaking
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Attach (or replace) the FaceSkin once it mounts; syncs current emotion. */
  attachFaceSkin(skin: FaceSkin | null): void {
    this.faceSkin = skin
    if (skin) {
      skin.setEmotion(this.deps.emotion.getState())
      skin.setSpeaking(this.speaking)
    }
  }

  // --- turn entry points ---------------------------------------------------

  /**
   * Run a full turn from a captured audio clip: transcribe → chat → speak.
   * A clip that arrives while a turn is active is a BARGE-IN — it aborts the
   * current turn first, then starts fresh.
   */
  async submitAudio(blob: Blob): Promise<void> {
    if (this.disposed) return
    if (this.isBusy()) this.interrupt()

    this.setStatus({ error: undefined })
    this.setPhase('transcribing')

    const controller = new AbortController()
    this.sttAbort = controller
    let result: SttResult
    try {
      result = await this.deps.transcribe(blob, {
        mode: this.deps.conversation.getState().settings.sttMode,
        language: this.deps.language,
        signal: controller.signal,
      })
    } catch (err) {
      this.sttAbort = null
      // An abort is a barge-in, not an error — a new turn already took over.
      if (isAbort(err)) return
      this.fail(sttErrorMessage(err))
      return
    }
    this.sttAbort = null
    if (this.disposed) return

    this.setStatus({
      sttEngine: result.engine,
      sttBackend: result.backend,
      lastTranscript: result.text,
    })

    const text = result.text.trim()
    if (!text) {
      // Nothing was said (silence / misfire) — quietly return to rest.
      this.setPhase('idle')
      return
    }
    this.runTurn(text)
  }

  /** Run a full turn from typed text (skips STT — used by the text input). */
  submitText(text: string): void {
    if (this.disposed) return
    const trimmed = text.trim()
    if (!trimmed) return
    if (this.isBusy()) this.interrupt()
    this.setStatus({ error: undefined, lastTranscript: trimmed })
    this.runTurn(trimmed)
  }

  // --- the chat + speak pipeline ------------------------------------------

  private runTurn(userText: string): void {
    const conv = this.deps.conversation
    conv.addUserTurn(userText)

    const { settings, system } = conv.getState()
    const provider = settings.provider
    if (!provider) {
      this.fail(
        'No brain is selected. Open settings and pick a provider (or wire an agent), then try again.',
      )
      return
    }
    const engine = settings.ttsEngine

    // Awaiting the first token: THINKING. We do NOT switch to SPEAKING here —
    // that handoff waits for real audio (the TTS `onStart`) so the mouth is
    // synced to sound, never to the raw token stream.
    this.setPhase('waiting')

    const callbacks: ChatDriverCallbacks = {
      onToken: (delta) => {
        // Live transcript: append the raw delta as it streams.
        conv.appendAssistantDelta(delta)
      },
      onSentence: (sentence) => {
        // Start speaking on the FIRST complete sentence for low latency.
        this.deps.tts.speak(sentence, { engine })
      },
      onDone: (chatResult) => {
        // Persist the directive-stripped spoken text and set the resting emotion.
        conv.finalizeAssistantTurn(chatResult.text)
        this.deps.emotion.setResting(chatResult.emotion)
        // If nothing was ever spoken (empty reply), the TTS `onEnd` won't fire —
        // settle to the resting emotion now.
        if (!this.speaking) this.setPhase('idle')
      },
      onError: (err) => {
        conv.finalizeAssistantTurn()
        this.fail(err.message)
      },
    }

    this.session = this.deps.runChat(
      {
        provider,
        model: settings.model ?? undefined,
        messages: conv.toMessages(),
        system,
      },
      callbacks,
    )
    // The session settles (clean/aborted/errored) via its own promise; clear our
    // handle when THIS session finishes so a later barge-in doesn't touch it.
    const settling = this.session
    void settling.done.then(() => {
      if (this.session === settling) this.session = null
    })
  }

  // --- TTS lifecycle hooks (wired to the router's callbacks) ---------------

  /** The first spoken sentence began — hand off to SPEAKING synced to audio. */
  handleSpeechStart(): void {
    if (this.disposed) return
    this.setSpeaking(true)
    this.setPhase('speaking')
    this.startMouthBridge()
  }

  /** The TTS queue drained naturally — settle back to the resting emotion. */
  handleSpeechEnd(): void {
    if (this.disposed) return
    this.stopMouthBridge()
    this.setSpeaking(false)
    this.setPhase('idle')
  }

  /** A non-recoverable TTS error surfaced out-of-band. */
  handleSpeechError(err: unknown): void {
    this.deps.warn?.(`[orchestrator] TTS error: ${describe(err)}`)
  }

  // --- barge-in ------------------------------------------------------------

  /**
   * Global interrupt (barge-in): abort the in-flight chat AND stop queued TTS,
   * finalize whatever partial reply exists so history stays coherent, and settle
   * the face. Safe to call when nothing is in flight.
   */
  interrupt(): void {
    // Abort a transcription that hasn't produced text yet.
    if (this.sttAbort) {
      try {
        this.sttAbort.abort()
      } catch {
        /* ignore */
      }
      this.sttAbort = null
    }
    // Abort the chat stream (stops token accumulation).
    if (this.session) {
      this.session.abort()
      this.session = null
    }
    // Persist any partial assistant text before it's cut off.
    this.deps.conversation.finalizeAssistantTurn()
    // Stop all speech immediately (no natural `onEnd`).
    this.deps.tts.stop()
    this.stopMouthBridge()
    this.setSpeaking(false)
  }

  /** VAD signalled the user is speaking OVER the face — a barge-in. */
  notifyUserSpeaking(): void {
    if (this.speaking || this.session) this.interrupt()
  }

  // --- mouth bridge (TTS mouthRef → FaceSkin) ------------------------------

  private startMouthBridge(): void {
    const { mouthRef, raf } = this.deps
    if (!mouthRef || !raf || this.frameId !== null) return
    const tick = (): void => {
      if (this.disposed || !this.speaking || !this.faceSkin) {
        this.frameId = null
        return
      }
      const m = mouthRef.current
      if (m) this.faceSkin.setMouth(m.open, m.viseme)
      this.frameId = raf(tick)
    }
    this.frameId = raf(tick)
  }

  private stopMouthBridge(): void {
    if (this.frameId !== null) {
      this.deps.caf?.(this.frameId)
      this.frameId = null
    }
    // Close the mouth on the skin so a static viseme doesn't linger.
    this.faceSkin?.setMouth(0, 'viseme_sil')
  }

  // --- FSM plumbing --------------------------------------------------------

  private setPhase(phase: LifecyclePhase): void {
    if (this.phase !== phase) {
      this.phase = phase
      this.deps.emotion.setPhase(phase)
    }
    this.setStatus({ phase })
  }

  private setSpeaking(on: boolean): void {
    if (this.speaking === on) return
    this.speaking = on
    this.faceSkin?.setSpeaking(on)
    this.deps.onFaceSpeakingChange?.(on)
    this.setStatus({ speaking: on })
  }

  private fail(message: string): void {
    this.setStatus({ error: message })
    this.setSpeaking(false)
    this.stopMouthBridge()
    this.setPhase('error')
  }

  private setStatus(patch: Partial<OrchestratorStatus>): void {
    this.status = { ...this.status, ...patch, phase: patch.phase ?? this.phase }
    this.emit()
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  // --- teardown ------------------------------------------------------------

  dispose(): void {
    this.disposed = true
    this.interrupt()
    this.stopMouthBridge()
    this.unsubEmotion?.()
    this.unsubEmotion = null
    this.listeners.clear()
    this.faceSkin = null
  }
}

/** Convenience factory mirroring the other subsystem factories. */
export function createOrchestrator(deps: OrchestratorDeps): ConversationOrchestrator {
  return new ConversationOrchestrator(deps)
}

// --- helpers ----------------------------------------------------------------

function isAbort(err: unknown): boolean {
  if (err instanceof AdapterError) return err.code === 'aborted'
  if (err && typeof err === 'object' && 'name' in err) {
    return (err as { name?: unknown }).name === 'AbortError'
  }
  return false
}

/** Prefer a typed STT error's message; fall back to a generic one. */
function sttErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string' && m) return m
  }
  return 'Transcription failed. You can still type your message.'
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
