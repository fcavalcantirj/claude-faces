import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTtsRouter,
  configureTtsRouter,
  getTtsRouter,
  speak as globalSpeak,
  stop as globalStop,
  DEFAULT_TTS_ENGINE,
  type TtsRouterDeps,
  type TtsRouterOptions,
} from '@/lib/tts/index'
import type { LipsyncFeatures } from '@/lib/lipsync'
import type { MouthState } from '@/components/agent-face'

// --- Fakes -----------------------------------------------------------------
// jsdom has no real audio graph / SpeechSynthesis, so every heavy primitive is
// injected and its lifecycle driven by hand for deterministic headless tests.

class FakeLipsync {
  connected: FakeAudioEl[] = []
  disconnectCount = 0
  frames = 0
  private vol = 0
  connectMediaElement(el: unknown) {
    this.connected.push(el as FakeAudioEl)
  }
  connectStream() {}
  processFrame() {
    this.frames += 1
    this.vol = 0.6
  }
  getFeatures(): LipsyncFeatures {
    return { volume: this.vol, viseme: 'viseme_aa', visemeScores: {} }
  }
  getEstimatedFeatures(): LipsyncFeatures {
    return { volume: 0, viseme: 'viseme_sil', visemeScores: {} }
  }
  disconnect() {
    this.disconnectCount += 1
    this.vol = 0
  }
  reset() {}
}

class FakeAudioEl {
  src = ''
  paused = true
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onplaying: (() => void) | null = null
  playCount = 0
  pauseCount = 0
  async play() {
    this.playCount += 1
    this.paused = false
  }
  pause() {
    this.pauseCount += 1
    this.paused = true
  }
  /** Test helper: simulate real audio beginning ('playing' event). */
  startPlaying() {
    this.onplaying?.()
  }
  /** Test helper: simulate the clip finishing. */
  end() {
    this.onended?.()
  }
}

class FakeWebSpeech {
  spoken: string[] = []
  cancelCount = 0
  disposeCount = 0
  private onStart?: () => void
  private onEnd?: () => void
  constructor(cb: { onStart?: () => void; onEnd?: () => void }) {
    this.onStart = cb.onStart
    this.onEnd = cb.onEnd
  }
  speak(text: string) {
    this.spoken.push(text)
  }
  /** Test helper: fire the audible start of the current utterance (u.onstart). */
  startLatest() {
    this.onStart?.()
  }
  /** Test helper: fire the end of the most recently spoken utterance. */
  finishLatest() {
    this.onEnd?.()
  }
  cancel() {
    this.cancelCount += 1
  }
  dispose() {
    this.disposeCount += 1
  }
  setVoice() {}
  getVoices() {
    return []
  }
  isSpeaking() {
    return false
  }
}

function makeSetup(over: Partial<TtsRouterOptions> = {}) {
  const mouthRef: { current: MouthState | null } = { current: null }
  const lipsync = new FakeLipsync()
  const audioEls: FakeAudioEl[] = []
  let webSpeech: FakeWebSpeech | null = null
  const revoked: string[] = []
  const created: string[] = []
  // Manual rAF: collect ticks so the test drives frames deterministically.
  let nextId = 1
  const scheduled = new Map<number, (t: number) => void>()

  const fetchImpl = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      okAudioResponse(),
  )

  const deps: TtsRouterDeps = {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    createLipsyncImpl: (() => lipsync) as unknown as TtsRouterDeps['createLipsyncImpl'],
    createWebSpeechImpl: ((cb: { onEnd?: () => void }) => {
      webSpeech = new FakeWebSpeech(cb)
      return webSpeech
    }) as unknown as TtsRouterDeps['createWebSpeechImpl'],
    createAudioElement: () => {
      const el = new FakeAudioEl()
      audioEls.push(el)
      return el as unknown as HTMLMediaElement
    },
    resumeAudioImpl: async () => undefined,
    createObjectURL: (b: Blob) => {
      const url = `blob:fake-${created.length}`
      created.push(url)
      void b
      return url
    },
    revokeObjectURL: (u: string) => {
      revoked.push(u)
    },
    raf: (cb) => {
      const id = nextId++
      scheduled.set(id, cb)
      return id
    },
    caf: (id) => {
      scheduled.delete(id)
    },
    warn: vi.fn(),
  }

  const callbacks = {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    onError: vi.fn(),
    onMouthSource: vi.fn(),
    onEngine: vi.fn(),
    onFirstAudible: vi.fn(),
  }

  const router = createTtsRouter({ mouthRef, ...over }, callbacks, deps)

  return {
    router,
    mouthRef,
    lipsync,
    audioEls,
    get webSpeech() {
      return webSpeech
    },
    revoked,
    created,
    fetchImpl,
    deps,
    callbacks,
    /** Fire one pending rAF tick. */
    tick() {
      const [id, cb] = [...scheduled.entries()][0] ?? []
      if (id !== undefined && cb) {
        scheduled.delete(id)
        cb(0)
      }
    },
    pendingFrames: () => scheduled.size,
  }
}

function okAudioResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
  } as unknown as Response
}

function errorResponse(status: number, code: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code, message: 'nope' } }),
    blob: async () => new Blob(),
  } as unknown as Response
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  const r = getTtsRouter()
  r?.dispose()
})

// --- default engine + web-speech path --------------------------------------

describe('TtsRouter — Web Speech path (estimated mouth)', () => {
  it('defaults to web-speech and drives the estimated mouth source', async () => {
    const s = makeSetup()
    expect(s.router.getEngine()).toBe(DEFAULT_TTS_ENGINE)
    s.router.speak('Hello there. How are you?')
    await flush()

    expect(s.webSpeech).not.toBeNull()
    expect(s.webSpeech!.spoken.length).toBeGreaterThan(0)
    expect(s.router.getMouthSource()).toBe('estimated')
    expect(s.callbacks.onStart).toHaveBeenCalledTimes(1)
    // The FFT analyser must NOT be tapped on the Web Speech path.
    expect(s.lipsync.connected.length).toBe(0)
  })

  it('speaks queued sentences one at a time and settles on natural end', async () => {
    const s = makeSetup()
    s.router.speak('One. Two. Three.')
    await flush()
    // Only the first sentence has been handed to the synth so far.
    expect(s.webSpeech!.spoken).toEqual(['One.'])

    s.webSpeech!.finishLatest()
    expect(s.webSpeech!.spoken).toEqual(['One.', 'Two.'])
    s.webSpeech!.finishLatest()
    expect(s.webSpeech!.spoken).toEqual(['One.', 'Two.', 'Three.'])

    expect(s.callbacks.onEnd).not.toHaveBeenCalled()
    s.webSpeech!.finishLatest() // last sentence ends → turn settles
    expect(s.callbacks.onEnd).toHaveBeenCalledTimes(1)
    expect(s.router.isSpeaking()).toBe(false)
    expect(s.router.getMouthSource()).toBe('off')
  })
})

// --- OpenAI path (real FFT analyser mouth) ---------------------------------

describe('TtsRouter — OpenAI path (real FFT mouth)', () => {
  it('fetches /api/tts, taps the clip through the analyser, and drives the mouth', async () => {
    const s = makeSetup({ defaultEngine: 'openai' })
    s.router.speak('Hello world.')
    await flush()

    // POSTed to the hosted TTS route with the sentence text.
    expect(s.fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = s.fetchImpl.mock.calls[0]
    expect(url).toBe('/api/tts')
    expect(JSON.parse(init!.body as string).text).toBe('Hello world.')

    // The audio element was tapped by the analyser (real FFT path).
    expect(s.audioEls.length).toBe(1)
    expect(s.lipsync.connected.length).toBe(1)
    expect(s.audioEls[0].playCount).toBe(1)
    expect(s.router.getMouthSource()).toBe('analyser')
    expect(s.callbacks.onStart).toHaveBeenCalledTimes(1)

    // A rAF tick pulls a real analyser feature into the shared mouthRef.
    s.tick()
    expect(s.lipsync.frames).toBeGreaterThan(0)
    expect(s.mouthRef.current?.open).toBeGreaterThan(0)
    expect(s.mouthRef.current?.viseme).toBe('viseme_aa')
  })

  it('advances to the next clip on ended and disconnects the analyser between clips', async () => {
    const s = makeSetup({ defaultEngine: 'openai' })
    s.router.speak('First. Second.')
    await flush()
    expect(s.audioEls.length).toBe(1)

    s.audioEls[0].end()
    await flush()
    // Clip 1's analyser source was disconnected before clip 2 attached.
    expect(s.lipsync.disconnectCount).toBeGreaterThanOrEqual(1)
    expect(s.audioEls.length).toBe(2)
    expect(s.revoked).toContain(s.created[0])

    s.audioEls[1].end()
    await flush()
    expect(s.callbacks.onEnd).toHaveBeenCalledTimes(1)
    expect(s.router.getMouthSource()).toBe('off')
  })

  it('falls back to Web Speech when the hosted TTS key is missing', async () => {
    const s = makeSetup({ defaultEngine: 'openai' })
    s.fetchImpl.mockResolvedValueOnce(errorResponse(400, 'unavailable'))
    s.router.speak('No key here.')
    await flush()

    // Failure switched the engine and re-voiced the text via Web Speech.
    expect(s.callbacks.onEngine).toHaveBeenCalledWith('web-speech')
    expect(s.router.getEngine()).toBe('web-speech')
    expect(s.webSpeech!.spoken).toEqual(['No key here.'])
    expect(s.deps.warn).toHaveBeenCalled()
  })
})

// --- barge-in + engine switching -------------------------------------------

describe('TtsRouter — barge-in + engine switching', () => {
  it('stop() silences audio, disconnects the analyser, and does not fire onEnd', async () => {
    const s = makeSetup({ defaultEngine: 'openai' })
    s.router.speak('Talking now. And more.')
    await flush()
    const el = s.audioEls[0]
    expect(el.playCount).toBe(1)

    s.router.stop()

    expect(el.pauseCount).toBeGreaterThan(0)
    expect(el.src).toBe('')
    expect(s.lipsync.disconnectCount).toBeGreaterThanOrEqual(1)
    expect(s.pendingFrames()).toBe(0) // rAF loop stopped
    expect(s.callbacks.onEnd).not.toHaveBeenCalled() // barge-in ≠ natural end
    expect(s.router.getMouthSource()).toBe('off')
    expect(s.mouthRef.current).toEqual({ open: 0, viseme: 'viseme_sil' })
    expect(s.router.isSpeaking()).toBe(false)

    // A late `ended` from the aborted clip must not resurrect the turn.
    el.end()
    await flush()
    expect(s.audioEls.length).toBe(1)
  })

  it('switching engine mid-turn tears down the analyser with no leftover connections', async () => {
    const s = makeSetup({ defaultEngine: 'openai' })
    s.router.speak('Hi.')
    await flush()
    expect(s.router.getMouthSource()).toBe('analyser')
    const before = s.lipsync.disconnectCount

    s.router.speak('Now via speech.', { engine: 'web-speech' })
    await flush()
    // The analyser clip was torn down (disconnected) when we switched.
    expect(s.lipsync.disconnectCount).toBeGreaterThan(before)
    expect(s.router.getEngine()).toBe('web-speech')
    expect(s.router.getMouthSource()).toBe('estimated')
    expect(s.callbacks.onEngine).toHaveBeenCalledWith('web-speech')
  })
})

// --- kokoro (stretch) not installed → graceful fallback --------------------

describe('TtsRouter — kokoro not installed', () => {
  it('falls back to Web Speech when no kokoro synthesizer is injected', async () => {
    const s = makeSetup({ defaultEngine: 'kokoro' })
    s.router.speak('Local voice.')
    await flush()
    expect(s.router.getEngine()).toBe('web-speech')
    expect(s.webSpeech!.spoken).toEqual(['Local voice.'])
  })
})

// --- module-level default router -------------------------------------------

describe('TtsRouter — first-audible instant (onFirstAudible)', () => {
  it('web-speech: fires once per turn at u.onstart, re-fires on the next turn', async () => {
    const s = makeSetup()
    s.router.speak('One. Two.')
    // Queued + markStarted happened, but nothing is AUDIBLE yet.
    expect(s.callbacks.onFirstAudible).not.toHaveBeenCalled()

    s.webSpeech!.startLatest() // real audio begins
    expect(s.callbacks.onFirstAudible).toHaveBeenCalledTimes(1)

    s.webSpeech!.finishLatest() // advance to sentence two
    s.webSpeech!.startLatest() // same turn — must NOT re-fire
    expect(s.callbacks.onFirstAudible).toHaveBeenCalledTimes(1)
    s.webSpeech!.finishLatest() // queue drains, turn ends
    expect(s.callbacks.onEnd).toHaveBeenCalledTimes(1)

    s.router.speak('Next turn.')
    s.webSpeech!.startLatest()
    expect(s.callbacks.onFirstAudible).toHaveBeenCalledTimes(2)
  })

  it("clip path: fires on the element's 'playing' event, once per turn", async () => {
    const s = makeSetup()
    s.router.speak('First clip. Second clip.', { engine: 'openai' })
    await flush()
    expect(s.callbacks.onFirstAudible).not.toHaveBeenCalled()

    s.audioEls[0].startPlaying()
    expect(s.callbacks.onFirstAudible).toHaveBeenCalledTimes(1)

    s.audioEls[0].end()
    await flush()
    s.audioEls[1].startPlaying() // same turn — no re-fire
    expect(s.callbacks.onFirstAudible).toHaveBeenCalledTimes(1)
  })

  it('stop() before audio starts: never fires, and the NEXT turn fires cleanly', async () => {
    const s = makeSetup()
    s.router.speak('Interrupted.', { engine: 'openai' })
    await flush()
    const stale = s.audioEls[0]
    s.router.stop()
    stale.startPlaying() // late 'playing' from the torn-down element
    expect(s.callbacks.onFirstAudible).not.toHaveBeenCalled()

    s.router.speak('Fresh turn.', { engine: 'openai' })
    await flush()
    s.audioEls[1].startPlaying()
    expect(s.callbacks.onFirstAudible).toHaveBeenCalledTimes(1)
  })
})

describe('module-level speak/stop', () => {
  it('routes global speak()/stop() to the configured default router', async () => {
    const mouthRef: { current: MouthState | null } = { current: null }
    let ws: FakeWebSpeech | null = null
    configureTtsRouter({ mouthRef }, {}, {
      createWebSpeechImpl: ((cb: { onEnd?: () => void }) => {
        ws = new FakeWebSpeech(cb)
        return ws
      }) as unknown as TtsRouterDeps['createWebSpeechImpl'],
    })
    globalSpeak('Hey.')
    await flush()
    expect(ws!.spoken).toEqual(['Hey.'])
    globalStop()
    expect(ws!.cancelCount).toBeGreaterThan(0)
  })
})
