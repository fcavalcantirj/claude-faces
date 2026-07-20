// Graceful degradation — the headlessly-testable core that answers "given THIS
// deployment's server keys AND this browser's abilities, what actually works,
// and what should we tell the user is missing?" It never throws and never
// hard-fails a capability: a missing piece becomes an explanatory, actionable
// message, not a crash. The React binding (`lib/use-capabilities.ts`) is a thin
// shell that fetches `/api/config`, sniffs the browser, and reconciles the
// persisted settings through these pure functions.
//
// The contract (kept consistent with docs/env-contract.md):
//   • Chat needs at least one reachable brain (a Mode A key OR the Mode B
//     agent-bridge). With none, the UI shows an "add a key / wire your agent"
//     state while the face stays interactive.
//   • Voice IN works whenever a mic exists AND some STT path is usable —
//     in-browser Whisper (WebGPU/WASM, $0) OR a hosted key.
//   • Voice OUT works whenever some TTS path is usable — Web Speech ($0) OR a
//     hosted OpenAI key.
//   • Auto-select the zero-key local paths (browser STT + Web Speech) when no
//     hosted key exists; pick hosted only when the key is present. Any explicit
//     selection that becomes invalid (key removed, agent gone) is reconciled
//     back to a working path rather than left broken.

import type { AppConfig } from '@/lib/settings/panel-model'
import { hasNoBrain, resolveActiveProvider } from '@/lib/settings/panel-model'
import type { SttMode } from '@/lib/stt'
import type { TtsEngine } from '@/lib/tts'
import type { ConversationSettings } from '@/lib/conversation'

// --- Browser capability sniffing --------------------------------------------

/** What the current browser can physically do for the voice+face pipeline. */
export interface BrowserCapabilities {
  /** `navigator.gpu` present — the fast in-browser Whisper backend (WebGPU). */
  webgpu: boolean
  /** WebAssembly present — the in-browser Whisper fallback backend. */
  wasm: boolean
  /** `MediaRecorder` present — needed to capture a spoken clip. */
  mediaRecorder: boolean
  /** `getUserMedia` present — mic access for a spoken turn. */
  microphone: boolean
  /** `speechSynthesis` present — the zero-key Web Speech voice-out. */
  speechSynthesis: boolean
  /** `crossOriginIsolated` — required for threaded WASM (SharedArrayBuffer). */
  crossOriginIsolated: boolean
  /** A secure context (https / localhost) — `getUserMedia` + WebGPU need it. */
  secureContext: boolean
}

/**
 * The minimal shape we read for capabilities. `globalThis` satisfies it in the
 * browser; tests pass a plain object so detection is deterministic and SSR-safe.
 */
export interface CapabilityScope {
  navigator?: {
    gpu?: unknown
    mediaDevices?: { getUserMedia?: unknown }
  }
  MediaRecorder?: unknown
  speechSynthesis?: unknown
  WebAssembly?: unknown
  crossOriginIsolated?: boolean
  isSecureContext?: boolean
}

/**
 * Read the browser feature flags off a scope (defaults to `globalThis`). Pure,
 * never throws — an absent field simply reports `false`, so this is safe to call
 * during SSR (where `navigator`/`window` don't exist) and in tests.
 */
export function detectBrowserCapabilities(scope?: CapabilityScope): BrowserCapabilities {
  const g: CapabilityScope =
    scope ?? (typeof globalThis !== 'undefined' ? (globalThis as CapabilityScope) : {})
  const nav = g.navigator
  return {
    webgpu: Boolean(nav?.gpu),
    wasm: typeof g.WebAssembly !== 'undefined',
    mediaRecorder: typeof g.MediaRecorder !== 'undefined',
    microphone: Boolean(nav?.mediaDevices?.getUserMedia),
    speechSynthesis: Boolean(g.speechSynthesis),
    crossOriginIsolated: g.crossOriginIsolated === true,
    secureContext: g.isSecureContext === true,
  }
}

// --- Capability helpers ------------------------------------------------------

/** In-browser Whisper is usable when either WebGPU or WASM is present. */
function browserSttUsable(browser: BrowserCapabilities): boolean {
  return browser.webgpu || browser.wasm
}

/** A hosted STT key (Groq or OpenAI) is present. */
function hostedSttKey(config: AppConfig): boolean {
  return config.stt.groq || config.stt.openai
}

/** The user can physically capture a spoken clip (mic + recorder + secure ctx). */
function micUsable(browser: BrowserCapabilities): boolean {
  return browser.mediaRecorder && browser.microphone && browser.secureContext
}

// --- Auto-selection (zero-key local first, hosted only when keyed) ----------

/**
 * The STT mode to prefer for THIS env+browser. Zero-key browser Whisper is the
 * default; when a hosted key exists we use browser-first `auto` (best of both:
 * local when the model is cached, hosted fallback otherwise). Falls back to
 * `hosted` only when the browser cannot run Whisper at all but a key exists.
 */
export function autoSelectStt(config: AppConfig, browser: BrowserCapabilities): SttMode {
  const browserOk = browserSttUsable(browser)
  const hostedOk = hostedSttKey(config)
  if (browserOk) return hostedOk ? 'auto' : 'browser'
  if (hostedOk) return 'hosted'
  // Nothing is usable; keep the zero-key default and let the UI explain.
  return 'browser'
}

/**
 * The TTS engine to prefer. Hosted OpenAI voice when its key exists (higher
 * fidelity + real FFT lip-sync), else the always-available zero-key Web Speech.
 */
export function autoSelectTts(config: AppConfig, _browser: BrowserCapabilities): TtsEngine {
  return config.tts.openai ? 'openai' : 'web-speech'
}

// --- Reconcile persisted settings against live capabilities -----------------

/** The settings fields this module reconciles (a subset of the full settings). */
export type ReconcilableSettings = Pick<
  ConversationSettings,
  'provider' | 'sttMode' | 'ttsEngine'
>

/**
 * Fix any persisted selection that is no longer usable in this deployment,
 * preserving valid explicit choices. A hosted STT mode with no hosted key falls
 * back to browser-first `auto`; an OpenAI voice with no key falls back to Web
 * Speech; a stale/removed provider resolves to the server default (else the
 * first available brain, else null). Never returns an unusable combination.
 */
export function reconcileSettings(
  settings: ReconcilableSettings,
  config: AppConfig,
  _browser: BrowserCapabilities,
): ReconcilableSettings {
  const provider = resolveActiveProvider(settings.provider, config)

  let sttMode = settings.sttMode
  if (sttMode === 'hosted' && !hostedSttKey(config)) sttMode = 'auto'

  let ttsEngine = settings.ttsEngine
  if (ttsEngine === 'openai' && !config.tts.openai) ttsEngine = 'web-speech'

  return { provider, sttMode, ttsEngine }
}

// --- The user-facing feature matrix -----------------------------------------

/** One capability's status, with an actionable message when it's unavailable. */
export interface FeatureStatus {
  /** Stable key ('chat' | 'voiceIn' | 'voiceOut'). */
  key: string
  /** Human label for the HUD/banner. */
  label: string
  /** Whether this capability works right now. */
  available: boolean
  /** When unavailable: a clear, actionable explanation (never a stack trace). */
  message?: string
}

/** The computed availability of the three top-level capabilities. */
export interface FeatureMatrix {
  /** Is any chat brain reachable? (Mode A key OR Mode B agent-bridge.) */
  chat: FeatureStatus
  /** Can the user speak a turn? (mic + some STT path.) */
  voiceIn: FeatureStatus
  /** Can the face speak back? (some TTS path.) */
  voiceOut: FeatureStatus
  /** The three statuses in render order. */
  features: FeatureStatus[]
}

const NO_BRAIN_MESSAGE =
  'No brain configured. Add a key on the server (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or ' +
  'GROQ_API_KEY) or wire your running agent (AGENT_BRIDGE_URL), then reload. The face still ' +
  'animates and you can browse — but chat is off until a brain is reachable.'

/**
 * On a plain-HTTP non-localhost origin the browser hides `navigator.mediaDevices`
 * entirely, so `microphone` reads false too — the origin, not missing hardware,
 * is the diagnosis. See skill/agent-face/references/remote.md.
 */
export const VOICE_IN_INSECURE_ORIGIN_MESSAGE =
  'Microphone blocked: this address is plain http:// and not localhost, so the browser ' +
  'hides the mic (and in-browser Whisper). Serve it over HTTPS — on a tailnet: ' +
  '`tailscale serve 3000` — or open it on the machine itself at localhost. ' +
  'You can still type your turns.'

export const VOICE_IN_NO_MIC_MESSAGE =
  'No microphone available: this browser has no audio capture (getUserMedia / MediaRecorder) ' +
  'or no input device. Connect a mic or use a current browser. You can still type your turns.'

/**
 * Compute what works for this deployment + browser. Pure and total: every
 * unavailable capability carries an actionable `message`, and the face is never
 * gated — only chat/voice are. This is what the app reads on load to decide
 * whether to show the "configure a brain" banner and the per-feature hints.
 */
export function computeFeatureMatrix(
  config: AppConfig,
  browser: BrowserCapabilities,
): FeatureMatrix {
  // Chat: any reachable brain (Mode A key OR Mode B agent-bridge).
  const chatOk = !hasNoBrain(config)
  const chat: FeatureStatus = {
    key: 'chat',
    label: 'Chat brain',
    available: chatOk,
    ...(chatOk ? {} : { message: NO_BRAIN_MESSAGE }),
  }

  // Voice in: need a mic AND some STT path (browser Whisper or a hosted key).
  const sttOk = browserSttUsable(browser) || hostedSttKey(config)
  const mic = micUsable(browser)
  const voiceInOk = mic && sttOk
  let voiceInMessage: string | undefined
  if (!voiceInOk) {
    if (!browser.secureContext) {
      voiceInMessage = VOICE_IN_INSECURE_ORIGIN_MESSAGE
    } else if (!mic) {
      voiceInMessage = VOICE_IN_NO_MIC_MESSAGE
    } else {
      voiceInMessage =
        'No speech-to-text available: this browser can’t run in-browser Whisper and no hosted ' +
        'STT key (GROQ_API_KEY / OPENAI_API_KEY) is set. You can still type your turns.'
    }
  }
  const voiceIn: FeatureStatus = {
    key: 'voiceIn',
    label: 'Voice input',
    available: voiceInOk,
    ...(voiceInMessage ? { message: voiceInMessage } : {}),
  }

  // Voice out: Web Speech ($0) OR hosted OpenAI TTS.
  const voiceOutOk = browser.speechSynthesis || config.tts.openai
  const voiceOut: FeatureStatus = {
    key: 'voiceOut',
    label: 'Voice output',
    available: voiceOutOk,
    ...(voiceOutOk
      ? {}
      : {
          message:
            'No voice-out available: this browser has no Web Speech API. Set OPENAI_API_KEY on ' +
            'the server for hosted TTS. Replies still appear as text.',
        }),
  }

  return { chat, voiceIn, voiceOut, features: [chat, voiceIn, voiceOut] }
}

// --- Safe fallback config ----------------------------------------------------

/**
 * An all-unavailable config used when `/api/config` can't be fetched (offline,
 * a 5xx, a self-host misconfig). The app still boots into a fully-local face;
 * the matrix simply reports chat off until the probe succeeds.
 */
export const EMPTY_CONFIG: AppConfig = {
  providers: {},
  agentBridge: { available: false },
  stt: { groq: false, openai: false },
  tts: { openai: false },
  defaultProvider: null,
}
