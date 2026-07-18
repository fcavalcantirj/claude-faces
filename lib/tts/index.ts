// The TTS router — one seam the orchestrator calls to SPEAK a reply, regardless
// of which voice engine renders it, and to STOP instantly for barge-in.
//
// It unifies two very different voice-out paths behind a single sentence queue:
//
//   • 'web-speech' — the browser SpeechSynthesis engine (zero infra). It plays
//     through the OS and exposes NO tappable audio node, so the mouth is driven
//     by a synthesized envelope (mouthSource 'estimated'). Delegated to
//     `WebSpeechTTS`, which already writes the estimated features into mouthRef.
//
//   • 'openai' / 'kokoro' — REAL audio clips. The bytes are fetched (OpenAI via
//     `/api/tts`; Kokoro via an injected local synthesizer), played through an
//     <audio> element created on the shared AudioContext, and tapped by
//     `wawa-lipsync` (`connectMediaElement`) so the mouth is driven by the REAL
//     FFT analyser (mouthSource 'analyser') — visibly better lip-sync than the
//     Web Speech estimate.
//
// The router owns the sentence queue: `speak(text)` appends sentence-sized
// chunks and starts playback on the FIRST sentence (so speech begins before the
// full reply arrives), and `stop()` is the global barge-in — it cancels the
// Web Speech queue, pauses+resets the audio element, aborts the in-flight
// `/api/tts` fetch, and disconnects the analyser source so a new utterance
// attaches cleanly with no leftover connections.
//
// It drives the emotion machine indirectly through callbacks: `onStart` fires
// when the first sentence begins (orchestrator → 'speaking') and `onEnd` fires
// when the queue drains naturally (orchestrator → resting emotion). A barge-in
// `stop()` does NOT fire `onEnd` (an interrupt is not a natural finish).
//
// Every heavy/browser primitive is injectable so the whole router is headlessly
// testable under jsdom with fakes — no real audio, no AudioContext, no network.

import { createLipsync, type LipsyncEngine, type LipsyncFeatures } from '@/lib/lipsync'
import { resumeAudio as defaultResumeAudio } from '@/lib/audio/context'
import {
  createWebSpeechTTS,
  chunkForSpeech,
  type WebSpeechTTS,
  type SpeechSynthesisVoiceLike,
} from '@/lib/tts/web-speech'
import { AdapterError } from '@/lib/providers/types'
import { errorFromResponse } from '@/lib/chat/client'
import type { MouthSource, MouthState } from '@/components/agent-face'

/** The voice-out engines the router can drive. */
export type TtsEngine = 'web-speech' | 'openai' | 'kokoro'

/** The default engine when a caller doesn't name one. */
export const DEFAULT_TTS_ENGINE: TtsEngine = 'web-speech'

/** Options passed to a single `speak()` call. */
export interface SpeakOptions {
  /** Which engine to voice this (and subsequent queued) text with. */
  engine?: TtsEngine
}

/** Lifecycle callbacks the orchestrator wires to the emotion machine + face. */
export interface TtsRouterCallbacks {
  /** The first sentence of a turn began — orchestrator sets emotion 'speaking'. */
  onStart?: () => void
  /** The queue drained naturally — orchestrator returns to the resting emotion. */
  onEnd?: () => void
  /** A non-recoverable engine error surfaced out-of-band. */
  onError?: (err: unknown) => void
  /** The active mouth source changed (orchestrator sets AgentFace `mouthSource`). */
  onMouthSource?: (source: MouthSource) => void
  /** The active engine changed (e.g. an OpenAI failure fell back to Web Speech). */
  onEngine?: (engine: TtsEngine) => void
  /** The Web Speech voice list changed (populate the settings picker). */
  onVoicesChanged?: (voices: SpeechSynthesisVoiceLike[]) => void
}

/** Voice/output options per engine + the shared mouth ref both paths write. */
export interface TtsRouterOptions {
  /** The ref the mouth reads each frame (shared with `AgentFace`). */
  mouthRef: { current: MouthState | null }
  /** Engine used when a `speak()` call omits one. Defaults to 'web-speech'. */
  defaultEngine?: TtsEngine
  /** OpenAI hosted-TTS voice/format + endpoint override. */
  openai?: { voice?: string; format?: string; endpoint?: string }
  /** Web Speech voice URI/name + prosody. */
  webSpeech?: { voiceURI?: string; lang?: string; rate?: number; pitch?: number }
  /**
   * When an OpenAI/Kokoro clip can't be produced (no key, network, load
   * failure), fall back to Web Speech for that + remaining text. Default true.
   */
  fallbackToWebSpeech?: boolean
}

/** A minimal audio-clip synthesizer for the Kokoro (or any local) engine. */
export type ClipSynthesizer = (text: string, signal: AbortSignal) => Promise<Blob>

/** Injectable heavy/browser primitives (defaults use the real ones). */
export interface TtsRouterDeps {
  fetchImpl?: typeof fetch
  createLipsyncImpl?: typeof createLipsync
  createWebSpeechImpl?: typeof createWebSpeechTTS
  /** Build a fresh <audio> element per clip (a tapped element can't be re-tapped). */
  createAudioElement?: () => HTMLMediaElement
  resumeAudioImpl?: () => Promise<unknown>
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  raf?: (cb: (t: number) => void) => number
  caf?: (id: number) => void
  warn?: (msg: string) => void
  /** Local synthesizer for engine 'kokoro' (lands in its own stretch task). */
  kokoroSynthesize?: ClipSynthesizer
}

interface QueueItem {
  text: string
  engine: TtsEngine
}

const SILENCE_VISEME = 'viseme_sil'

/**
 * The TTS router. Construct once (via {@link createTtsRouter}) with the shared
 * mouthRef + lifecycle callbacks, then `speak(text)` to queue a reply and
 * `stop()` to barge-in.
 */
export class TtsRouter {
  private readonly callbacks: TtsRouterCallbacks
  private readonly options: TtsRouterOptions
  private readonly deps: TtsRouterDeps

  private engine: TtsEngine
  private queue: QueueItem[] = []
  /** True while a clip/utterance is actively playing (pump is busy). */
  private active = false
  /** True between the first onStart and the settling onEnd of a turn. */
  private started = false
  /** Bumped on every stop() so stale async continuations no-op. */
  private gen = 0
  private mouthSource: MouthSource = 'off'

  private webSpeech: WebSpeechTTS | null = null
  private lipsync: LipsyncEngine | null = null
  private currentAudio: HTMLMediaElement | null = null
  private currentUrl: string | null = null
  private fetchAbort: AbortController | null = null
  private frameId: number | null = null

  constructor(
    options: TtsRouterOptions,
    callbacks: TtsRouterCallbacks = {},
    deps: TtsRouterDeps = {},
  ) {
    this.options = options
    this.callbacks = callbacks
    this.deps = deps
    this.engine = options.defaultEngine ?? DEFAULT_TTS_ENGINE
  }

  /** The engine the next dequeued item will use. */
  getEngine(): TtsEngine {
    return this.engine
  }

  /** Where the mouth currently gets its motion. */
  getMouthSource(): MouthSource {
    return this.mouthSource
  }

  /** True while a turn is being spoken. */
  isSpeaking(): boolean {
    return this.started
  }

  /** Web Speech voices (for the settings picker); empty until the engine loads. */
  getVoices(): SpeechSynthesisVoiceLike[] {
    return this.webSpeech?.getVoices() ?? []
  }

  /**
   * Queue `text` (split into sentence-sized chunks) and begin speaking on the
   * FIRST chunk. Called incrementally by the chat client so speech starts before
   * the reply completes. `opts.engine` selects the engine for this + later items.
   */
  speak(text: string, opts: SpeakOptions = {}): void {
    if (opts.engine && opts.engine !== this.engine) {
      this.setEngine(opts.engine)
    }
    const chunks = chunkForSpeech(text)
    if (chunks.length === 0) return
    for (const chunk of chunks) this.queue.push({ text: chunk, engine: this.engine })
    this.pump()
  }

  /**
   * Switch the active engine. If a turn is in flight on the analyser path, the
   * current clip is stopped and its analyser source disconnected so the new
   * engine attaches with no leftover connections; queued text is preserved and
   * re-voiced with the new engine.
   */
  setEngine(engine: TtsEngine): void {
    if (engine === this.engine) return
    const hadTurn = this.started
    const pending = this.queue.map((q) => q.text)
    // Tear down any in-flight playback (disconnects the analyser source).
    this.teardownPlayback()
    this.queue = pending.map((t) => ({ text: t, engine }))
    this.engine = engine
    this.setMouthSource('off')
    this.callbacks.onEngine?.(engine)
    if (hadTurn && this.queue.length > 0) this.pump()
  }

  /** Update the Web Speech voice (by voiceURI or name). */
  setVoice(voiceURIorName: string | undefined): void {
    this.options.webSpeech = { ...this.options.webSpeech, voiceURI: voiceURIorName }
    this.webSpeech?.setVoice(voiceURIorName)
  }

  /**
   * Barge-in: stop ALL speech immediately. Cancels the Web Speech queue,
   * pauses+resets the audio element, aborts the in-flight `/api/tts` fetch, and
   * disconnects the analyser source. Does NOT fire `onEnd` — an interrupt is not
   * a natural finish.
   */
  stop(): void {
    this.gen += 1
    this.queue = []
    this.started = false
    this.active = false
    this.webSpeech?.cancel()
    this.teardownPlayback()
    this.writeSilence()
    this.setMouthSource('off')
  }

  /** Release listeners/nodes; call when tearing the router down for good. */
  dispose(): void {
    this.stop()
    this.webSpeech?.dispose()
    this.webSpeech = null
    this.lipsync?.disconnect()
    this.lipsync = null
  }

  // --- queue pump ----------------------------------------------------------

  private pump(): void {
    if (this.active) return
    const item = this.queue.shift()
    if (!item) {
      if (this.started) this.finishTurn()
      return
    }
    this.active = true
    if (item.engine === 'web-speech') {
      this.playWebSpeech(item.text)
    } else {
      void this.playClip(item)
    }
  }

  /** Advance to the next queued item (called when a clip/utterance ends). */
  private advance(gen: number): void {
    if (gen !== this.gen) return
    this.active = false
    this.pump()
  }

  private finishTurn(): void {
    this.started = false
    this.active = false
    this.writeSilence()
    this.setMouthSource('off')
    this.callbacks.onEnd?.()
  }

  private markStarted(): void {
    if (!this.started) {
      this.started = true
      this.callbacks.onStart?.()
    }
  }

  // --- Web Speech path (estimated mouth) -----------------------------------

  private playWebSpeech(text: string): void {
    const gen = this.gen
    const ws = this.ensureWebSpeech()
    this.setMouthSource('estimated')
    this.markStarted()
    ws.speak(text)
    // `ensureWebSpeech` wires onEnd → advance; nothing else to do here.
    void gen
  }

  private ensureWebSpeech(): WebSpeechTTS {
    if (this.webSpeech) return this.webSpeech
    const make = this.deps.createWebSpeechImpl ?? createWebSpeechTTS
    this.webSpeech = make(
      {
        // Fires when a single queued sentence finishes — advance the router queue.
        onEnd: () => this.advance(this.gen),
        onError: (err) => this.callbacks.onError?.(err),
        onVoicesChanged: (voices) => this.callbacks.onVoicesChanged?.(voices),
      },
      {
        mouthRef: this.options.mouthRef,
        voiceURI: this.options.webSpeech?.voiceURI,
        lang: this.options.webSpeech?.lang,
        rate: this.options.webSpeech?.rate,
        pitch: this.options.webSpeech?.pitch,
      },
    )
    return this.webSpeech
  }

  // --- Analyser path (real FFT mouth: OpenAI / Kokoro) ---------------------

  private async playClip(item: QueueItem): Promise<void> {
    const gen = this.gen
    let url: string | null = null
    try {
      const blob = await this.fetchClip(item)
      if (gen !== this.gen) return // stopped mid-fetch

      const createUrl = this.deps.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b))
      url = createUrl(blob)
      this.currentUrl = url

      const el = (this.deps.createAudioElement ?? (() => new Audio()))()
      el.src = url
      this.currentAudio = el

      const lip = this.ensureLipsync()
      lip.connectMediaElement(el)
      this.setMouthSource('analyser')
      this.markStarted()

      el.onended = () => {
        if (gen !== this.gen) return
        this.teardownPlayback()
        this.advance(gen)
      }
      el.onerror = () => {
        if (gen !== this.gen) return
        this.teardownPlayback()
        // A decode/playback failure shouldn't kill the turn — advance.
        this.advance(gen)
      }

      await (this.deps.resumeAudioImpl ?? defaultResumeAudio)()
      if (gen !== this.gen) return
      this.startAnalyserLoop(gen)
      await el.play()
    } catch (err) {
      if (gen !== this.gen) return
      if (url) this.revoke(url)
      this.currentUrl = null
      this.currentAudio = null
      this.stopAnalyserLoop()
      this.handleClipFailure(item, err)
    }
  }

  /** Obtain the audio bytes for a clip (OpenAI over HTTP; Kokoro locally). */
  private async fetchClip(item: QueueItem): Promise<Blob> {
    const controller = new AbortController()
    this.fetchAbort = controller

    if (item.engine === 'kokoro') {
      if (!this.deps.kokoroSynthesize) {
        throw new AdapterError(
          'unavailable',
          'The Kokoro engine is not installed; falling back to Web Speech.',
        )
      }
      return this.deps.kokoroSynthesize(item.text, controller.signal)
    }

    // engine === 'openai'
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const endpoint = this.options.openai?.endpoint ?? '/api/tts'
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: item.text,
        voice: this.options.openai?.voice,
        format: this.options.openai?.format,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      // Parse the route's typed { error } body (falls back to a status error).
      throw await errorFromResponse(res, 'OpenAI')
    }
    return res.blob()
  }

  /** A clip couldn't be produced — fall back to Web Speech (or surface the error). */
  private handleClipFailure(item: QueueItem, err: unknown): void {
    // Aborts are barge-in, not errors — swallow (gen guard already handled it).
    if (err instanceof AdapterError && err.code === 'aborted') {
      this.active = false
      return
    }
    if (this.options.fallbackToWebSpeech !== false) {
      this.deps.warn?.(
        `TTS engine '${item.engine}' failed (${describeError(err)}); falling back to Web Speech.`,
      )
      // Re-voice this item + everything still queued via Web Speech.
      const remaining = [item.text, ...this.queue.map((q) => q.text)]
      this.queue = remaining.map((t) => ({ text: t, engine: 'web-speech' }))
      this.engine = 'web-speech'
      this.callbacks.onEngine?.('web-speech')
      this.active = false
      this.pump()
      return
    }
    this.callbacks.onError?.(err)
    this.active = false
    this.pump()
  }

  private ensureLipsync(): LipsyncEngine {
    if (!this.lipsync) {
      this.lipsync = (this.deps.createLipsyncImpl ?? createLipsync)()
    }
    return this.lipsync
  }

  private startAnalyserLoop(gen: number): void {
    if (this.frameId !== null) return
    const raf = this.deps.raf ?? defaultRaf
    const tick = () => {
      if (gen !== this.gen || !this.lipsync || !this.currentAudio) {
        this.frameId = null
        return
      }
      this.lipsync.processFrame()
      this.writeMouth(this.lipsync.getFeatures())
      this.frameId = raf(tick)
    }
    this.frameId = raf(tick)
  }

  private stopAnalyserLoop(): void {
    if (this.frameId !== null) {
      ;(this.deps.caf ?? defaultCaf)(this.frameId)
      this.frameId = null
    }
  }

  // --- shared teardown -----------------------------------------------------

  /** Stop and release the current clip's element, analyser source, and URL. */
  private teardownPlayback(): void {
    this.active = false
    this.stopAnalyserLoop()
    if (this.fetchAbort) {
      try {
        this.fetchAbort.abort()
      } catch {
        // ignore
      }
      this.fetchAbort = null
    }
    if (this.currentAudio) {
      this.currentAudio.onended = null
      this.currentAudio.onerror = null
      try {
        this.currentAudio.pause()
      } catch {
        // ignore
      }
      try {
        this.currentAudio.src = ''
      } catch {
        // ignore
      }
      this.currentAudio = null
    }
    // Disconnect the analyser source so the next clip attaches cleanly.
    this.lipsync?.disconnect()
    if (this.currentUrl) {
      this.revoke(this.currentUrl)
      this.currentUrl = null
    }
  }

  private revoke(url: string): void {
    const revoke = this.deps.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u))
    try {
      revoke(url)
    } catch {
      // ignore
    }
  }

  private writeMouth(features: LipsyncFeatures): void {
    this.options.mouthRef.current = { open: features.volume, viseme: features.viseme }
  }

  private writeSilence(): void {
    this.options.mouthRef.current = { open: 0, viseme: SILENCE_VISEME }
  }

  private setMouthSource(source: MouthSource): void {
    if (this.mouthSource === source) return
    this.mouthSource = source
    this.callbacks.onMouthSource?.(source)
  }
}

function describeError(err: unknown): string {
  if (err instanceof AdapterError) return err.code
  if (err instanceof Error) return err.message
  return String(err)
}

function defaultRaf(cb: (t: number) => void): number {
  if (typeof requestAnimationFrame !== 'undefined') return requestAnimationFrame(cb)
  return setTimeout(() => cb(Date.now()), 16) as unknown as number
}

function defaultCaf(id: number): void {
  if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(id)
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
}

/** Convenience factory mirroring the other engine factories. */
export function createTtsRouter(
  options: TtsRouterOptions,
  callbacks?: TtsRouterCallbacks,
  deps?: TtsRouterDeps,
): TtsRouter {
  return new TtsRouter(options, callbacks, deps)
}

// --- module-level default router -------------------------------------------
// The orchestrator configures ONE shared router (with the shared mouthRef +
// emotion callbacks) then drives it through the global `speak`/`stop` the spec
// asks for. `configureTtsRouter` must be called before the globals are used.

let defaultRouter: TtsRouter | null = null

/** Install (replacing any previous) the process-wide default router. */
export function configureTtsRouter(
  options: TtsRouterOptions,
  callbacks?: TtsRouterCallbacks,
  deps?: TtsRouterDeps,
): TtsRouter {
  defaultRouter?.dispose()
  defaultRouter = createTtsRouter(options, callbacks, deps)
  return defaultRouter
}

/** The configured default router, or null if `configureTtsRouter` wasn't called. */
export function getTtsRouter(): TtsRouter | null {
  return defaultRouter
}

/** Global speak — routes to the configured default router (no-op if unset). */
export function speak(text: string, opts?: SpeakOptions): void {
  defaultRouter?.speak(text, opts)
}

/** Global barge-in stop — silences the configured default router. */
export function stop(): void {
  defaultRouter?.stop()
}
