import { describe, it, expect, beforeEach } from 'vitest'
import {
  createOrchestrator,
  type OrchestratorTts,
  type RunChatFn,
  type TranscribeFn,
} from '@/lib/orchestrator'
import { createConversationStore, type StorageLike } from '@/lib/conversation'
import { RecorderError } from '@/lib/audio/recorder'
import { createEmotionStore } from '@/lib/face/emotion-machine'
import type {
  ChatDriverCallbacks,
  ChatResult,
  ChatSession,
} from '@/lib/chat/client'
import type { SttResult } from '@/lib/stt'
import type { FaceSkin } from '@/lib/face/skin'
import type { Emotion } from '@/lib/face-points'

function memoryStorage(): StorageLike {
  const dump: Record<string, string> = {}
  return {
    getItem: (k) => (k in dump ? dump[k] : null),
    setItem: (k, v) => {
      dump[k] = v
    },
    removeItem: (k) => {
      delete dump[k]
    },
  }
}

/** A hand-drivable fake chat driver: capture callbacks, emit events on demand. */
function makeFakeChat() {
  let cbs: ChatDriverCallbacks | null = null
  let resolveDone!: (r: ChatResult) => void
  let aborted = false
  const done = new Promise<ChatResult>((r) => (resolveDone = r))
  const runChat: RunChatFn = (_opts, callbacks) => {
    cbs = callbacks
    const session: ChatSession = {
      controller: new AbortController(),
      abort: () => {
        aborted = true
        resolveDone({ raw: '', text: '', emotion: 'neutral', aborted: true })
      },
      done,
    }
    return session
  }
  return {
    runChat,
    token: (t: string) => cbs?.onToken?.(t, t),
    firstToken: () => cbs?.onFirstToken?.(),
    sentence: (s: string) => cbs?.onSentence?.(s),
    finish: (result: Partial<ChatResult>) => {
      const full: ChatResult = {
        raw: result.raw ?? '',
        text: result.text ?? '',
        emotion: result.emotion ?? 'neutral',
        aborted: false,
        ...result,
      }
      cbs?.onDone?.(full)
      resolveDone(full)
    },
    error: (message: string) =>
      cbs?.onError?.(
        Object.assign(new Error(message), { code: 'server_error' }) as never,
      ),
    get aborted() {
      return aborted
    },
  }
}

function makeFakeTts() {
  const spoken: string[] = []
  let stops = 0
  const tts: OrchestratorTts = {
    speak: (text) => spoken.push(text),
    stop: () => {
      stops++
    },
  }
  return {
    tts,
    spoken,
    get stops() {
      return stops
    },
  }
}

function makeFakeSkin() {
  const calls = { emotion: [] as Emotion[], speaking: [] as boolean[], mouth: 0 }
  const skin: FaceSkin = {
    id: 'eidolon',
    setEmotion: (e) => calls.emotion.push(e),
    setSpeaking: (on) => calls.speaking.push(on),
    setMouth: () => {
      calls.mouth++
    },
    setViseme: () => {},
    mount: () => {},
    dispose: () => {},
  }
  return { skin, calls }
}

describe('conversation orchestrator', () => {
  let conversation: ReturnType<typeof createConversationStore>
  let emotion: ReturnType<typeof createEmotionStore>

  beforeEach(() => {
    conversation = createConversationStore({ storage: memoryStorage() })
    conversation.setProvider('groq')
    conversation.setModel('llama-3.1-8b-instant')
    emotion = createEmotionStore()
  })

  it('passes the settings voice language to STT (auto → undefined; deps override wins)', async () => {
    const seenLanguages: Array<string | undefined> = []
    const transcribe: TranscribeFn = async (_blob, opts) => {
      seenLanguages.push(opts?.language)
      return { text: 'oi', engine: 'hosted' }
    }

    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe,
      runChat: makeFakeChat().runChat,
    })

    await orch.submitAudio(new Blob(['a'])) // shipped default: English pin
    conversation.setSttLanguage('auto')
    await orch.submitAudio(new Blob(['b']))
    expect(seenLanguages).toEqual(['en', undefined])

    // An explicit deps.language (embedder override, free BCP-47 string) beats
    // the settings picker.
    const pinned = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe,
      runChat: makeFakeChat().runChat,
      language: 'pt',
    })
    conversation.setSttLanguage('en')
    await pinned.submitAudio(new Blob(['c']))
    expect(seenLanguages).toEqual(['en', undefined, 'pt'])
  })

  it('runs a full spoken turn: transcribe → chat → speak → lip-sync → rest', async () => {
    const chat = makeFakeChat()
    const tts = makeFakeTts()
    const skin = makeFakeSkin()
    const transcribe: TranscribeFn = async () => ({
      text: 'what is the weather',
      engine: 'browser',
      backend: 'webgpu',
    })

    const phases: string[] = []
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: tts.tts,
      transcribe,
      runChat: chat.runChat,
      faceSkin: skin.skin,
    })
    orch.subscribe(() => phases.push(orch.getPhase()))

    await orch.submitAudio(new Blob(['x']))
    // The user turn was transcribed and recorded.
    expect(orch.getStatus().sttEngine).toBe('browser')
    expect(conversation.getState().turns.at(-1)).toMatchObject({
      role: 'user',
      content: 'what is the weather',
    })
    // Awaiting the first token → THINKING (not speaking yet).
    expect(orch.getPhase()).toBe('waiting')
    expect(emotion.getState()).toBe('thinking')

    // Tokens stream into the live transcript.
    chat.token('Sunny')
    chat.token(' and warm.')
    expect(conversation.getState().turns.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Sunny and warm.',
      pending: true,
    })
    // Still THINKING during the stream — audio hasn't started.
    expect(emotion.getState()).toBe('thinking')

    // First complete sentence → TTS speaks it.
    chat.sentence('Sunny and warm.')
    expect(tts.spoken).toEqual(['Sunny and warm.'])

    // The TTS engine reports audio started → SPEAKING synced to sound.
    orch.handleSpeechStart()
    expect(orch.getPhase()).toBe('speaking')
    expect(orch.isSpeaking()).toBe(true)
    expect(emotion.getState()).toBe('speaking')
    expect(skin.calls.speaking).toContain(true)

    // Stream ends with a happy resting directive.
    chat.finish({ text: 'Sunny and warm.', emotion: 'happy' })
    await chat.finish // flush microtasks
    // Still speaking (queue not drained) — do NOT rest yet.
    expect(orch.getPhase()).toBe('speaking')
    expect(conversation.getState().turns.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Sunny and warm.',
      pending: false,
    })

    // Queue drains → settle to the resting (happy) emotion.
    orch.handleSpeechEnd()
    expect(orch.getPhase()).toBe('idle')
    expect(orch.isSpeaking()).toBe(false)
    expect(emotion.getState()).toBe('happy') // resting directive applied
    expect(skin.calls.speaking).toContain(false)

    expect(phases).toContain('transcribing')
    expect(phases).toContain('waiting')
    expect(phases).toContain('speaking')
  })

  it('interrupting mid-reply aborts chat + TTS and starts a clean new turn', async () => {
    const first = makeFakeChat()
    const tts = makeFakeTts()
    let which = 0
    const runChat: RunChatFn = (opts, cbs) => {
      which++
      return which === 1 ? first.runChat(opts, cbs) : second.runChat(opts, cbs)
    }
    const second = makeFakeChat()

    const transcribe: TranscribeFn = async (blob): Promise<SttResult> => ({
      text: (await blob.text()) === '1' ? 'first question' : 'second question',
      engine: 'hosted',
      provider: 'groq',
    })

    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: tts.tts,
      transcribe,
      runChat,
    })

    await orch.submitAudio(new Blob(['1']))
    first.token('Let me think about')
    first.sentence('Let me think about it.')
    orch.handleSpeechStart()
    expect(orch.isSpeaking()).toBe(true)

    // Barge-in: a NEW clip arrives mid-reply.
    await orch.submitAudio(new Blob(['2']))
    // The first turn was aborted and TTS was stopped.
    expect(first.aborted).toBe(true)
    expect(tts.stops).toBeGreaterThanOrEqual(1)
    // The partial first reply was finalized (history stays coherent).
    const turns = conversation.getState().turns
    expect(turns.some((t) => t.role === 'assistant' && t.pending)).toBe(false)
    // A fresh user turn for the new question was recorded.
    expect(turns.at(-1)).toMatchObject({ role: 'user', content: 'second question' })

    // The new turn runs cleanly to completion.
    second.token('The answer is 42.')
    second.sentence('The answer is 42.')
    orch.handleSpeechStart()
    second.finish({ text: 'The answer is 42.', emotion: 'neutral' })
    orch.handleSpeechEnd()
    expect(orch.getPhase()).toBe('idle')
    expect(tts.spoken).toContain('The answer is 42.')
  })

  it('surfaces an STT failure as an error phase without crashing', async () => {
    const chat = makeFakeChat()
    const tts = makeFakeTts()
    const transcribe: TranscribeFn = async () => {
      throw Object.assign(new Error('No speech-to-text is available.'), {
        code: 'no_stt_available',
      })
    }
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: tts.tts,
      transcribe,
      runChat: chat.runChat,
    })

    await orch.submitAudio(new Blob(['x']))
    expect(orch.getPhase()).toBe('error')
    expect(orch.getStatus().error).toMatch(/speech-to-text/i)
    expect(emotion.getState()).toBe('glitch')
  })

  it('submitText runs a turn without STT and errors clearly with no brain', () => {
    const chat = makeFakeChat()
    const tts = makeFakeTts()
    const noBrain = createConversationStore({ storage: memoryStorage() })
    const orch = createOrchestrator({
      conversation: noBrain,
      emotion,
      tts: tts.tts,
      transcribe: async () => ({ text: '', engine: 'browser' }),
      runChat: chat.runChat,
    })
    orch.submitText('hello there')
    expect(noBrain.getState().turns.at(-1)).toMatchObject({
      role: 'user',
      content: 'hello there',
    })
    // No provider selected → error phase with a helpful message.
    expect(orch.getPhase()).toBe('error')
    expect(orch.getStatus().error).toMatch(/brain/i)
  })

  it('bridges the TTS mouthRef into the FaceSkin while speaking', () => {
    const chat = makeFakeChat()
    const tts = makeFakeTts()
    const skin = makeFakeSkin()
    const mouthRef = { current: { open: 0.7, viseme: 'viseme_aa' } }
    // A single-step rAF: run the tick once, then report "cancelled".
    let ran = false
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: tts.tts,
      transcribe: async () => ({ text: 'hi', engine: 'browser' }),
      runChat: chat.runChat,
      faceSkin: skin.skin,
      mouthRef,
      raf: (cb) => {
        if (!ran) {
          ran = true
          cb(0)
        }
        return 1
      },
      caf: () => {},
    })

    orch.handleSpeechStart()
    // The bridge copied the mouth features into the skin at least once.
    expect(skin.calls.mouth).toBeGreaterThan(0)
    orch.handleSpeechEnd()
    expect(orch.isSpeaking()).toBe(false)
  })

  it('records the full stage timeline for a vad turn with an injected clock', async () => {
    const chat = makeFakeChat()
    let t = 0
    const completed: unknown[] = []
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe: async () => {
        t += 900 // STT wall time
        return { text: 'hi there', engine: 'hosted', latencyMs: 640 }
      },
      runChat: chat.runChat,
      now: () => t,
      vadTailMs: 1400,
      onTurnComplete: (timings) => completed.push(timings),
    })

    await orch.submitAudio(new Blob(['x']), { source: 'vad' })
    t += 7000
    chat.firstToken()
    t += 400
    chat.sentence('Hello there.')
    t += 20
    orch.handleSpeechStart()
    t += 380
    orch.handleFirstAudible()
    chat.finish({ text: 'Hello there.' })
    orch.handleSpeechEnd()

    const log = orch.getTurnLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      input: 'vad',
      vadTailMs: 1400,
      sttMs: 900,
      sttEngine: 'hosted',
      sttUpstreamMs: 640,
      ttftMs: 7900,
      firstSentenceMs: 8300,
      ttsStartMs: 8320,
      firstAudibleMs: 8700,
      ttfwMs: 8700 + 1400,
      outcome: 'complete',
    })
    expect(completed).toHaveLength(1)
    expect(orch.getStatus().latency).toMatchObject({ ttfwMs: 8700 + 1400 })
  })

  it('a typed turn records no stt/vad fields and ttfw equals firstAudible', () => {
    const chat = makeFakeChat()
    let t = 0
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe: async () => ({ text: 'unused', engine: 'browser' }),
      runChat: chat.runChat,
      now: () => t,
      vadTailMs: 1400,
    })
    orch.submitText('hello')
    t += 3000
    chat.firstToken()
    t += 500
    orch.handleSpeechStart()
    orch.handleFirstAudible()
    orch.handleSpeechEnd()

    const rec = orch.getTurnLog()[0]
    expect(rec.input).toBe('typed')
    expect(rec.vadTailMs).toBeUndefined()
    expect(rec.sttMs).toBeUndefined()
    expect(rec.ttfwMs).toBe(3500)
  })

  it('wiring onFirstToken is timing-only: phase and emotion do not change', () => {
    const chat = makeFakeChat()
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe: async () => ({ text: 'unused', engine: 'browser' }),
      runChat: chat.runChat,
      now: () => 0,
    })
    orch.submitText('hello')
    expect(orch.getPhase()).toBe('waiting')
    const emotionBefore = emotion.getState()
    chat.firstToken()
    // The SPEAKING handoff still waits for real audio (TTS onStart).
    expect(orch.getPhase()).toBe('waiting')
    expect(emotion.getState()).toBe(emotionBefore)
  })

  it('a barge-in finalizes the in-flight record as aborted and starts a fresh one', () => {
    const chat = makeFakeChat()
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe: async () => ({ text: 'unused', engine: 'browser' }),
      runChat: chat.runChat,
      now: () => 0,
    })
    orch.submitText('first')
    orch.submitText('second') // barge-in
    const log = orch.getTurnLog()
    expect(log).toHaveLength(1)
    expect(log[0].outcome).toBe('aborted')
  })

  it('a silent transcript ends the record as empty; status.latency stays unset mid-turn', async () => {
    const chat = makeFakeChat()
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe: async () => ({ text: '   ', engine: 'browser' }),
      runChat: chat.runChat,
      now: () => 0,
    })
    await orch.submitAudio(new Blob(['x']), { source: 'ptt' })
    expect(orch.getTurnLog()[0].outcome).toBe('empty')
    expect(orch.getStatus().latency).toBeUndefined()
  })

  it('reportMicError surfaces the RecorderError message without entering the error phase', () => {
    const chat = makeFakeChat()
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe: async () => ({ text: 'hi', engine: 'browser' }),
      runChat: chat.runChat,
    })
    let notified = 0
    orch.subscribe(() => notified++)
    orch.reportMicError(
      new RecorderError(
        'insecure-context',
        'Microphone capture is blocked on this insecure address. Serve over HTTPS or open on localhost.',
      ),
    )
    // The turn never began: red toast, but NO error phase / glitch face.
    expect(orch.getStatus().error).toMatch(/HTTPS/)
    expect(orch.getPhase()).toBe('idle')
    expect(emotion.getState()).not.toBe('glitch')
    expect(notified).toBeGreaterThan(0)
  })

  it('reportMicError uses a generic message for non-recorder errors', () => {
    const chat = makeFakeChat()
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe: async () => ({ text: 'hi', engine: 'browser' }),
      runChat: chat.runChat,
    })
    orch.reportMicError(new Error('AudioContext exploded'))
    expect(orch.getStatus().error).toMatch(/microphone/i)
    expect(orch.getStatus().error).toMatch(/type/i)
    expect(orch.getPhase()).toBe('idle')
  })

  it('the next submitted turn clears a mic error', () => {
    const chat = makeFakeChat()
    const orch = createOrchestrator({
      conversation,
      emotion,
      tts: makeFakeTts().tts,
      transcribe: async () => ({ text: 'hi', engine: 'browser' }),
      runChat: chat.runChat,
    })
    orch.reportMicError(new RecorderError('not-supported', 'no mic here'))
    expect(orch.getStatus().error).toBeTruthy()
    orch.submitText('typed instead')
    expect(orch.getStatus().error).toBeUndefined()
  })
})
