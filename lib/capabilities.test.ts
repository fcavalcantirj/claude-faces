import { describe, it, expect } from 'vitest'
import {
  EMPTY_CONFIG,
  detectBrowserCapabilities,
  computeFeatureMatrix,
  autoSelectStt,
  autoSelectTts,
  reconcileSettings,
  type BrowserCapabilities,
  type CapabilityScope,
} from './capabilities'
import type { AppConfig } from '@/lib/settings/panel-model'

// --- Fixtures ---------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    providers: {
      anthropic: { available: false, label: 'Anthropic', mode: 'A' },
      openrouter: { available: false, label: 'OpenRouter', mode: 'A' },
      groq: { available: false, label: 'Groq', mode: 'A' },
    },
    agentBridge: { available: false },
    stt: { groq: false, openai: false },
    tts: { openai: false },
    defaultProvider: null,
    ...overrides,
  }
}

/** A browser that can do everything (modern Chrome, isolated, secure). */
function fullBrowser(): BrowserCapabilities {
  return {
    webgpu: true,
    wasm: true,
    mediaRecorder: true,
    microphone: true,
    speechSynthesis: true,
    crossOriginIsolated: true,
    secureContext: true,
  }
}

/** A browser that can do nothing (SSR / locked down). */
function bareBrowser(): BrowserCapabilities {
  return {
    webgpu: false,
    wasm: false,
    mediaRecorder: false,
    microphone: false,
    speechSynthesis: false,
    crossOriginIsolated: false,
    secureContext: false,
  }
}

// --- detectBrowserCapabilities ----------------------------------------------

describe('detectBrowserCapabilities', () => {
  it('reads the feature flags off a provided scope', () => {
    const scope: CapabilityScope = {
      navigator: { gpu: {}, mediaDevices: { getUserMedia: () => {} } },
      MediaRecorder: function () {},
      speechSynthesis: {},
      WebAssembly: {},
      crossOriginIsolated: true,
      isSecureContext: true,
    }
    expect(detectBrowserCapabilities(scope)).toEqual(fullBrowser())
  })

  it('returns all-false for an empty scope (SSR safe, never throws)', () => {
    expect(detectBrowserCapabilities({})).toEqual(bareBrowser())
  })

  it('detects a browser without WebGPU but with WASM (fallback path)', () => {
    const scope: CapabilityScope = {
      navigator: { mediaDevices: { getUserMedia: () => {} } },
      MediaRecorder: function () {},
      speechSynthesis: {},
      WebAssembly: {},
      crossOriginIsolated: false,
      isSecureContext: true,
    }
    const caps = detectBrowserCapabilities(scope)
    expect(caps.webgpu).toBe(false)
    expect(caps.wasm).toBe(true)
    expect(caps.microphone).toBe(true)
  })
})

// --- autoSelectStt / autoSelectTts ------------------------------------------

describe('autoSelectStt', () => {
  it('prefers the zero-key browser worker when no hosted key exists', () => {
    expect(autoSelectStt(makeConfig(), fullBrowser())).toBe('browser')
  })

  it('uses browser-first auto when a hosted key exists (best of both)', () => {
    expect(autoSelectStt(makeConfig({ stt: { groq: true, openai: false } }), fullBrowser())).toBe(
      'auto',
    )
  })

  it('falls back to hosted when the browser cannot run Whisper but a key exists', () => {
    const caps = { ...bareBrowser(), speechSynthesis: true }
    expect(autoSelectStt(makeConfig({ stt: { groq: false, openai: true } }), caps)).toBe('hosted')
  })

  it('still returns a browser default when nothing is usable (UI explains)', () => {
    expect(autoSelectStt(makeConfig(), bareBrowser())).toBe('browser')
  })
})

describe('autoSelectTts', () => {
  it('picks the zero-key Web Speech voice when no OpenAI key exists', () => {
    expect(autoSelectTts(makeConfig(), fullBrowser())).toBe('web-speech')
  })

  it('picks hosted OpenAI voice when the key exists', () => {
    expect(autoSelectTts(makeConfig({ tts: { openai: true } }), fullBrowser())).toBe('openai')
  })
})

// --- reconcileSettings ------------------------------------------------------

describe('reconcileSettings', () => {
  it('keeps a valid explicit selection untouched', () => {
    const config = makeConfig({
      providers: {
        anthropic: { available: true, label: 'Anthropic', mode: 'A' },
        openrouter: { available: false, label: 'OpenRouter', mode: 'A' },
        groq: { available: false, label: 'Groq', mode: 'A' },
      },
      stt: { groq: true, openai: false },
      tts: { openai: true },
      defaultProvider: 'anthropic',
    })
    const out = reconcileSettings(
      { provider: 'anthropic', sttMode: 'hosted', ttsEngine: 'openai' },
      config,
      fullBrowser(),
    )
    expect(out).toEqual({ provider: 'anthropic', sttMode: 'hosted', ttsEngine: 'openai' })
  })

  it('degrades a hosted STT selection to browser-first auto when the key is gone', () => {
    const out = reconcileSettings(
      { provider: null, sttMode: 'hosted', ttsEngine: 'web-speech' },
      makeConfig(),
      fullBrowser(),
    )
    expect(out.sttMode).toBe('auto')
  })

  it('degrades an OpenAI voice selection to Web Speech when the key is gone', () => {
    const out = reconcileSettings(
      { provider: null, sttMode: 'auto', ttsEngine: 'openai' },
      makeConfig(),
      fullBrowser(),
    )
    expect(out.ttsEngine).toBe('web-speech')
  })

  it('resolves a stale provider to the server default, else the first available', () => {
    const config = makeConfig({
      providers: {
        anthropic: { available: false, label: 'Anthropic', mode: 'A' },
        openrouter: { available: true, label: 'OpenRouter', mode: 'A' },
        groq: { available: true, label: 'Groq', mode: 'A' },
      },
      defaultProvider: 'groq',
    })
    const out = reconcileSettings(
      { provider: 'anthropic', sttMode: 'auto', ttsEngine: 'web-speech' },
      config,
      fullBrowser(),
    )
    expect(out.provider).toBe('groq')
  })

  it('leaves provider null when no brain is configured at all', () => {
    const out = reconcileSettings(
      { provider: 'anthropic', sttMode: 'auto', ttsEngine: 'web-speech' },
      makeConfig(),
      fullBrowser(),
    )
    expect(out.provider).toBeNull()
  })
})

// --- computeFeatureMatrix ---------------------------------------------------

describe('computeFeatureMatrix', () => {
  it('with zero keys but a capable browser: no chat, but voice-in/out still work', () => {
    const m = computeFeatureMatrix(makeConfig(), fullBrowser())
    expect(m.chat.available).toBe(false)
    expect(m.chat.message).toMatch(/add a key|wire your running agent/i)
    // Browser Whisper + a mic means the user can still speak a turn.
    expect(m.voiceIn.available).toBe(true)
    // Web Speech means the face can still talk back.
    expect(m.voiceOut.available).toBe(true)
  })

  it('marks chat available when any brain is reachable', () => {
    const config = makeConfig({
      providers: {
        anthropic: { available: true, label: 'Anthropic', mode: 'A' },
        openrouter: { available: false, label: 'OpenRouter', mode: 'A' },
        groq: { available: false, label: 'Groq', mode: 'A' },
      },
      defaultProvider: 'anthropic',
    })
    expect(computeFeatureMatrix(config, fullBrowser()).chat.available).toBe(true)
  })

  it('marks chat available via the agent-bridge alone (Mode B in dev)', () => {
    const config = makeConfig({ agentBridge: { available: true } })
    expect(computeFeatureMatrix(config, fullBrowser()).chat.available).toBe(true)
  })

  it('reports voice-in unavailable with an actionable message when no mic and no STT', () => {
    // Secure context but zero capture support — the plain no-mic branch (an
    // insecure context is a DIFFERENT branch, tested below).
    const m = computeFeatureMatrix(makeConfig(), { ...bareBrowser(), secureContext: true })
    expect(m.voiceIn.available).toBe(false)
    expect(m.voiceIn.message).toBeTruthy()
    expect(m.voiceIn.message).not.toMatch(/tailscale|HTTPS/)
  })

  it('names the insecure origin and the HTTPS/tailscale remedy when the context is insecure', () => {
    // A plain-HTTP non-localhost origin: the browser hides mediaDevices, so
    // `microphone` is ALSO false — the message must diagnose the ORIGIN, not
    // claim there is no mic.
    const caps = {
      ...fullBrowser(),
      microphone: false,
      secureContext: false,
      crossOriginIsolated: false,
    }
    const m = computeFeatureMatrix(makeConfig(), caps)
    expect(m.voiceIn.available).toBe(false)
    expect(m.voiceIn.message).toMatch(/tailscale serve 3000/)
    expect(m.voiceIn.message).toMatch(/localhost/)
    expect(m.voiceIn.message).toMatch(/HTTPS/)
    expect(m.voiceIn.message).not.toMatch(/No speech-to-text/)
  })

  it('keeps a plain no-mic message on a secure context without capture support', () => {
    const caps = { ...fullBrowser(), mediaRecorder: false, microphone: false }
    const m = computeFeatureMatrix(makeConfig(), caps)
    expect(m.voiceIn.available).toBe(false)
    expect(m.voiceIn.message).toMatch(/microphone/i)
    expect(m.voiceIn.message).not.toMatch(/tailscale|HTTPS/)
  })

  it('reports voice-out unavailable when neither Web Speech nor hosted TTS exists', () => {
    const caps = { ...bareBrowser() } // no speechSynthesis
    const m = computeFeatureMatrix(makeConfig(), caps)
    expect(m.voiceOut.available).toBe(false)
    expect(m.voiceOut.message).toMatch(/OPENAI_API_KEY|text/i)
  })

  it('voice-in survives on hosted STT alone (no browser Whisper) when a mic exists', () => {
    const caps = { ...bareBrowser(), mediaRecorder: true, microphone: true, secureContext: true }
    const config = makeConfig({ stt: { groq: true, openai: false } })
    expect(computeFeatureMatrix(config, caps).voiceIn.available).toBe(true)
  })

  it('exposes an ordered features list for rendering', () => {
    const m = computeFeatureMatrix(makeConfig(), fullBrowser())
    expect(Array.isArray(m.features)).toBe(true)
    expect(m.features.map((f) => f.key)).toContain('chat')
    // Every unavailable feature carries an actionable message.
    for (const f of m.features) {
      if (!f.available) expect(f.message, `${f.key} needs a message`).toBeTruthy()
    }
  })
})

// --- EMPTY_CONFIG -----------------------------------------------------------

describe('EMPTY_CONFIG', () => {
  it('is a safe all-unavailable fallback when /api/config cannot be fetched', () => {
    expect(EMPTY_CONFIG.defaultProvider).toBeNull()
    expect(EMPTY_CONFIG.agentBridge.available).toBe(false)
    expect(EMPTY_CONFIG.stt).toEqual({ groq: false, openai: false })
    expect(EMPTY_CONFIG.tts).toEqual({ openai: false })
    // A capable browser + the empty config still yields a working local face.
    const m = computeFeatureMatrix(EMPTY_CONFIG, fullBrowser())
    expect(m.chat.available).toBe(false)
    expect(m.voiceOut.available).toBe(true)
  })
})
