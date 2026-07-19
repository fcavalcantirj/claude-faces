// The conversation state store — the single source of truth for "what has been
// said" and "who is answering". It holds the ordered turns, the active system
// prompt (persona), and the selected provider/model, and it exposes the exact
// mutations the chat client drives:
//
//   addUserTurn(text)          — the human said something
//   appendAssistantDelta(text) — a streamed token arrived (opens a pending turn)
//   finalizeAssistantTurn(?)   — the reply finished (optionally replace w/ spoken)
//   reset()                    — clear history (keeps provider/model + persona)
//
// It is a tiny framework-free observable store (same idiom as
// `createEmotionStore`) so it is fully headlessly testable, and it persists a
// versioned snapshot to `localStorage` so a refresh restores the session. A
// character-budget cap keeps the history — and therefore the `/api/chat` request
// body — comfortably under Vercel's ~4.5 MB request limit.

import type { ChatMessage } from '@/lib/providers'
import { DEFAULT_PERSONA_PROMPT } from '@/lib/persona'
// Type-only imports (erased at runtime) so the store stays framework-free and
// never pulls the heavy TTS/STT/skin runtimes into a plain state module.
import type { SttMode } from '@/lib/stt'
import type { TtsEngine } from '@/lib/tts'
import type { FaceSkinId } from '@/lib/face/skin'

/** A role a turn can carry. `system` turns are metadata, never sent as messages. */
export type ConversationRole = 'user' | 'assistant' | 'system'

/** One entry in the transcript. */
export interface ConversationTurn {
  /** Stable id for React keys / dedupe. */
  id: string
  role: ConversationRole
  content: string
  /** True while an assistant turn is still streaming (excluded from history). */
  pending?: boolean
  /** Creation timestamp (ms). */
  createdAt: number
}

/**
 * How the user talks to the face. The two modes are MUTUALLY EXCLUSIVE — the
 * orchestrator runs push-to-talk (hold to record) OR hands-free VAD (Silero
 * auto-detects speech), never both. Selected here so it survives a reload.
 */
export type InputMode = 'push-to-talk' | 'hands-free'

/** Default input mode when none has been chosen/persisted. */
export const DEFAULT_INPUT_MODE: InputMode = 'push-to-talk'

/**
 * Voice/face defaults. Defined locally (not imported from the TTS/STT/skin
 * runtimes) so this state module stays free of their browser-heavy code:
 *   • STT `auto` — browser-first, hosted fallback (the $0/private default).
 *   • TTS `web-speech` — the zero-infra browser voice (no key needed).
 *   • Face `eidolon` — the always-present particle renderer.
 */
export const DEFAULT_STT_MODE: SttMode = 'auto'
export const DEFAULT_TTS_ENGINE: TtsEngine = 'web-speech'
export const DEFAULT_FACE_SKIN: FaceSkinId = 'eidolon'

/**
 * Transcription language. Whisper's per-clip auto-detect misreads accented
 * speech (accented English → Portuguese phonetic soup, seen live 2026-07-19),
 * so the user can pin it. English is the DEFAULT — auto-detect proved itself
 * unreliable on short accented clips, and the app speaks English out of the
 * box. To offer another language: extend this union AND the VOICE LANGUAGE
 * picker in settings-panel; values no longer in the union self-heal to the
 * default on load (a Português option existed briefly on 2026-07-19).
 */
export type SttLanguage = 'auto' | 'en'
export const STT_LANGUAGES: readonly SttLanguage[] = ['auto', 'en']
export const DEFAULT_STT_LANGUAGE: SttLanguage = 'en'

/** The hint actually sent to STT: `auto` means "send nothing, let it detect". */
export function sttLanguageHint(language: SttLanguage): string | undefined {
  return language === 'auto' ? undefined : language
}

/** Which brain is currently selected. `null` = not chosen yet. */
export interface ConversationSettings {
  provider: string | null
  model: string | null
  /** Push-to-talk vs hands-free VAD (mutually exclusive). */
  inputMode: InputMode
  /** Speech-to-text path: browser Whisper, hosted, or auto. */
  sttMode: SttMode
  /** Transcription language pin (auto = per-clip detection). */
  sttLanguage: SttLanguage
  /** Voice-out engine: Web Speech, OpenAI, or local Kokoro. */
  ttsEngine: TtsEngine
  /** Which face renderer drives the visuals. */
  faceSkin: FaceSkinId
}

/** The full, immutable store state. */
export interface ConversationState {
  turns: ConversationTurn[]
  settings: ConversationSettings
  /** The active persona / system prompt sent alongside the messages. */
  system: string
}

/** The subset of the DOM `Storage` API this store needs (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Versioned localStorage key — bumping the version invalidates old blobs. */
export const CONVERSATION_STORAGE_VERSION = 1
export const CONVERSATION_STORAGE_KEY = 'agent-face:conversation:v1'

/**
 * Max total characters of transcript content retained. 600k chars is ~1.8 MB
 * even if every character is a 3-byte UTF-8 codepoint — well under the ~4.5 MB
 * request cap `/api/chat` enforces (see `app/api/chat/route.ts`).
 */
export const MAX_HISTORY_CHARS = 600_000
/** Hard cap on retained turns, as a second safety belt on body size. */
export const MAX_TURNS = 100

export interface ConversationStoreOptions {
  /** Persistence backend. Defaults to `window.localStorage` when available. */
  storage?: StorageLike | null
  /** Clock, injectable for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
  /** Id generator, injectable for deterministic tests. */
  idFactory?: () => string
  /** Override the initial system prompt (defaults to the FACE persona). */
  system?: string
}

export interface ConversationStore {
  /** The current immutable state snapshot (stable ref until a mutation). */
  getState(): ConversationState
  /** Subscribe to changes; returns an unsubscribe fn (for useSyncExternalStore). */
  subscribe(listener: () => void): () => void
  /** Record a user turn and return it. */
  addUserTurn(content: string): ConversationTurn
  /** Append a streamed token to the pending assistant turn (creating it if needed). */
  appendAssistantDelta(delta: string): ConversationTurn
  /**
   * Finalize the pending assistant turn (mark it non-streaming). Optionally
   * replace its content with `finalText` — e.g. the directive-stripped spoken
   * text so the persisted history matches what was actually said.
   */
  finalizeAssistantTurn(finalText?: string): ConversationTurn | null
  /** Set the active persona / system prompt. */
  setSystem(system: string): void
  /** Set the selected provider (brain). */
  setProvider(provider: string | null): void
  /** Set the selected model. */
  setModel(model: string | null): void
  /** Set the input mode (push-to-talk vs hands-free VAD). */
  setInputMode(mode: InputMode): void
  /** Set the speech-to-text path (browser | hosted | auto). */
  setSttMode(mode: SttMode): void
  /** Pin the transcription language (auto = per-clip detection). */
  setSttLanguage(language: SttLanguage): void
  /** Set the voice-out engine (web-speech | openai | kokoro). */
  setTtsEngine(engine: TtsEngine): void
  /** Set the face renderer skin (eidolon | talkinghead). */
  setFaceSkin(skin: FaceSkinId): void
  /** Set any subset of settings together. */
  setSettings(settings: Partial<ConversationSettings>): void
  /** Clear the transcript (keeps provider/model + persona) and persist the clear. */
  reset(): void
  /** Build the `/api/chat` messages array: user/assistant, finalized only. */
  toMessages(): ChatMessage[]
}

/** Resolve the default persistence backend (browser localStorage, else none). */
function defaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    /* access can throw in sandboxed / privacy modes — degrade to no persistence */
  }
  return null
}

/** Shape of the persisted blob. */
interface PersistedConversation {
  version: number
  turns: ConversationTurn[]
  settings: ConversationSettings
  system: string
}

function emptySettings(): ConversationSettings {
  return {
    provider: null,
    model: null,
    inputMode: DEFAULT_INPUT_MODE,
    sttMode: DEFAULT_STT_MODE,
    sttLanguage: DEFAULT_STT_LANGUAGE,
    ttsEngine: DEFAULT_TTS_ENGINE,
    faceSkin: DEFAULT_FACE_SKIN,
  }
}

/** Coerce a persisted value to a valid SttLanguage (defaulting missing/garbage). */
function normalizeSttLanguage(value: unknown): SttLanguage {
  return (STT_LANGUAGES as readonly unknown[]).includes(value)
    ? (value as SttLanguage)
    : DEFAULT_STT_LANGUAGE
}

/** Coerce a persisted value to a valid InputMode (defaulting missing/garbage). */
function normalizeInputMode(value: unknown): InputMode {
  return value === 'hands-free' || value === 'push-to-talk'
    ? value
    : DEFAULT_INPUT_MODE
}

/** Coerce a persisted value to a valid SttMode (defaulting missing/garbage). */
function normalizeSttMode(value: unknown): SttMode {
  return value === 'browser' || value === 'hosted' || value === 'auto'
    ? value
    : DEFAULT_STT_MODE
}

/** Coerce a persisted value to a valid TtsEngine (defaulting missing/garbage). */
function normalizeTtsEngine(value: unknown): TtsEngine {
  return value === 'web-speech' || value === 'openai' || value === 'kokoro'
    ? value
    : DEFAULT_TTS_ENGINE
}

/** Coerce a persisted value to a valid FaceSkinId (defaulting missing/garbage). */
function normalizeFaceSkin(value: unknown): FaceSkinId {
  return value === 'eidolon' || value === 'talkinghead'
    ? value
    : DEFAULT_FACE_SKIN
}

/** Load + validate a persisted snapshot, or return null on any problem. */
function loadPersisted(
  storage: StorageLike | null,
  fallbackSystem: string,
): Partial<ConversationState> | null {
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(CONVERSATION_STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const blob = parsed as Partial<PersistedConversation>
  if (blob.version !== CONVERSATION_STORAGE_VERSION) return null
  const turns = Array.isArray(blob.turns)
    ? blob.turns.filter(
        (t): t is ConversationTurn =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as ConversationTurn).content === 'string' &&
          typeof (t as ConversationTurn).role === 'string',
      )
    : []
  const settings: ConversationSettings = {
    provider:
      typeof blob.settings?.provider === 'string' ? blob.settings.provider : null,
    model: typeof blob.settings?.model === 'string' ? blob.settings.model : null,
    inputMode: normalizeInputMode(blob.settings?.inputMode),
    sttMode: normalizeSttMode(blob.settings?.sttMode),
    sttLanguage: normalizeSttLanguage(blob.settings?.sttLanguage),
    ttsEngine: normalizeTtsEngine(blob.settings?.ttsEngine),
    faceSkin: normalizeFaceSkin(blob.settings?.faceSkin),
  }
  return {
    // Restored turns are never mid-stream.
    turns: turns.map((t) => ({ ...t, pending: false })),
    settings,
    system: typeof blob.system === 'string' ? blob.system : fallbackSystem,
  }
}

/**
 * Create a conversation store. All state lives outside React so the chat client
 * can mutate it from event handlers and every subscriber re-renders.
 */
export function createConversationStore(
  options: ConversationStoreOptions = {},
): ConversationStore {
  const storage = options.storage === undefined ? defaultStorage() : options.storage
  const now = options.now ?? Date.now
  let idCounter = 0
  const idFactory =
    options.idFactory ?? (() => `turn-${now()}-${++idCounter}`)
  const baseSystem = options.system ?? DEFAULT_PERSONA_PROMPT

  const restored = loadPersisted(storage, baseSystem)
  let state: ConversationState = {
    turns: restored?.turns ?? [],
    settings: restored?.settings ?? emptySettings(),
    system: restored?.system ?? baseSystem,
  }

  const listeners = new Set<() => void>()
  const emit = () => {
    for (const l of listeners) l()
  }

  const persist = () => {
    if (!storage) return
    const blob: PersistedConversation = {
      version: CONVERSATION_STORAGE_VERSION,
      // Never persist an in-flight (pending) turn.
      turns: state.turns.filter((t) => !t.pending),
      settings: state.settings,
      system: state.system,
    }
    try {
      storage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(blob))
    } catch {
      /* quota / privacy mode — persistence is best-effort */
    }
  }

  /** Trim the OLDEST turns until we're back under the char + count budgets. */
  function capTurns(turns: ConversationTurn[]): ConversationTurn[] {
    let out = turns
    const total = () => out.reduce((n, t) => n + t.content.length, 0)
    while (out.length > 1 && (total() > MAX_HISTORY_CHARS || out.length > MAX_TURNS)) {
      out = out.slice(1)
    }
    return out
  }

  /** Replace state immutably, persist, and notify. */
  const commit = (turns: ConversationTurn[], patch: Partial<ConversationState> = {}) => {
    state = {
      turns: capTurns(turns),
      settings: patch.settings ?? state.settings,
      system: patch.system ?? state.system,
    }
    persist()
    emit()
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    addUserTurn(content) {
      const turn: ConversationTurn = {
        id: idFactory(),
        role: 'user',
        content,
        createdAt: now(),
      }
      commit([...state.turns, turn])
      return turn
    },

    appendAssistantDelta(delta) {
      const last = state.turns[state.turns.length - 1]
      if (last && last.role === 'assistant' && last.pending) {
        const updated: ConversationTurn = { ...last, content: last.content + delta }
        commit([...state.turns.slice(0, -1), updated])
        return updated
      }
      const turn: ConversationTurn = {
        id: idFactory(),
        role: 'assistant',
        content: delta,
        pending: true,
        createdAt: now(),
      }
      commit([...state.turns, turn])
      return turn
    },

    finalizeAssistantTurn(finalText) {
      const idx = state.turns.findIndex(
        (t) => t.role === 'assistant' && t.pending,
      )
      if (idx === -1) return null
      const prev = state.turns[idx]
      const finalized: ConversationTurn = {
        ...prev,
        content: finalText ?? prev.content,
        pending: false,
      }
      const turns = [...state.turns]
      turns[idx] = finalized
      commit(turns)
      return finalized
    },

    setSystem(system) {
      if (system === state.system) return
      commit(state.turns, { system })
    },

    setProvider(provider) {
      if (provider === state.settings.provider) return
      commit(state.turns, { settings: { ...state.settings, provider } })
    },

    setModel(model) {
      if (model === state.settings.model) return
      commit(state.turns, { settings: { ...state.settings, model } })
    },

    setInputMode(mode) {
      if (mode === state.settings.inputMode) return
      commit(state.turns, { settings: { ...state.settings, inputMode: mode } })
    },

    setSttLanguage(language) {
      if (language === state.settings.sttLanguage) return
      commit(state.turns, { settings: { ...state.settings, sttLanguage: language } })
    },
    setSttMode(mode) {
      if (mode === state.settings.sttMode) return
      commit(state.turns, { settings: { ...state.settings, sttMode: mode } })
    },

    setTtsEngine(engine) {
      if (engine === state.settings.ttsEngine) return
      commit(state.turns, { settings: { ...state.settings, ttsEngine: engine } })
    },

    setFaceSkin(skin) {
      if (skin === state.settings.faceSkin) return
      commit(state.turns, { settings: { ...state.settings, faceSkin: skin } })
    },

    setSettings(partial) {
      commit(state.turns, { settings: { ...state.settings, ...partial } })
    },

    reset() {
      commit([], {})
    },

    toMessages() {
      return state.turns
        .filter((t) => !t.pending && (t.role === 'user' || t.role === 'assistant'))
        .map((t) => ({ role: t.role as ChatMessage['role'], content: t.content }))
    },
  }
}
