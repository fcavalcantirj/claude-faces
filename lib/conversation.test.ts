import { describe, it, expect, beforeEach } from 'vitest'
import {
  createConversationStore,
  CONVERSATION_STORAGE_KEY,
  MAX_HISTORY_CHARS,
  type StorageLike,
} from '@/lib/conversation'
import { DEFAULT_PERSONA_PROMPT } from '@/lib/persona'

/** A minimal in-memory Storage double (jsdom localStorage works too, but this
 *  keeps each test hermetic and lets us inspect the raw persisted blob). */
function memoryStorage(seed: Record<string, string> = {}): StorageLike & {
  dump: Record<string, string>
} {
  const dump: Record<string, string> = { ...seed }
  return {
    dump,
    getItem: (k) => (k in dump ? dump[k] : null),
    setItem: (k, v) => {
      dump[k] = v
    },
    removeItem: (k) => {
      delete dump[k]
    },
  }
}

// Deterministic id/clock so assertions don't depend on Date.now / randomness.
function seq() {
  let n = 0
  return () => ++n
}

describe('conversation store', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('accumulates a coherent multi-turn history for /api/chat', () => {
    const now = seq()
    const store = createConversationStore({ storage, now, idFactory: () => `id-${now()}` })

    store.addUserTurn('Hello there')
    // Assistant streams in over several deltas, then finalizes.
    store.appendAssistantDelta('Hi')
    store.appendAssistantDelta(', friend!')
    store.finalizeAssistantTurn()

    store.addUserTurn('How are you?')
    store.appendAssistantDelta('Doing great.')
    store.finalizeAssistantTurn()

    const messages = store.toMessages()
    expect(messages).toEqual([
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi, friend!' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'Doing great.' },
    ])
  })

  it('excludes the still-streaming (pending) assistant turn from toMessages', () => {
    const store = createConversationStore({ storage })
    store.addUserTurn('Question')
    store.appendAssistantDelta('partial...')
    // Not finalized yet — should not be resent to the brain.
    expect(store.toMessages()).toEqual([{ role: 'user', content: 'Question' }])
    store.finalizeAssistantTurn()
    expect(store.toMessages()).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'partial...' },
    ])
  })

  it('finalizeAssistantTurn can replace the accumulated text (spoken text)', () => {
    const store = createConversationStore({ storage })
    store.addUserTurn('hi')
    store.appendAssistantDelta('Hi [[face:happy]]')
    store.finalizeAssistantTurn('Hi')
    expect(store.toMessages().at(-1)).toEqual({ role: 'assistant', content: 'Hi' })
  })

  it('defaults the system prompt to the FACE persona and lets it be overridden', () => {
    const store = createConversationStore({ storage })
    expect(store.getState().system).toBe(DEFAULT_PERSONA_PROMPT)
    store.setSystem('be terse')
    expect(store.getState().system).toBe('be terse')
  })

  it('tracks the selected provider/model', () => {
    const store = createConversationStore({ storage })
    expect(store.getState().settings.provider).toBeNull()
    store.setProvider('groq')
    store.setModel('llama-3.1-8b-instant')
    expect(store.getState().settings).toEqual({
      provider: 'groq',
      model: 'llama-3.1-8b-instant',
      inputMode: 'push-to-talk',
      sttMode: 'auto',
      sttLanguage: 'en',
      ttsEngine: 'web-speech',
      faceSkin: 'eidolon',
    })
  })

  it('defaults to push-to-talk and toggles the input mode (mutually exclusive)', () => {
    const store = createConversationStore({ storage })
    expect(store.getState().settings.inputMode).toBe('push-to-talk')
    store.setInputMode('hands-free')
    expect(store.getState().settings.inputMode).toBe('hands-free')
    // A brand-new store over the SAME storage = a page reload → mode restored.
    const reloaded = createConversationStore({ storage })
    expect(reloaded.getState().settings.inputMode).toBe('hands-free')
  })

  it('voice language: defaults to ENGLISH, persists an explicit choice, rejects junk', () => {
    // Whisper auto-detect misreads accented English as Portuguese (live,
    // 2026-07-19), so English is the shipped default; the picker pins any
    // other choice, and the pin must survive a reload.
    const store = createConversationStore({ storage })
    expect(store.getState().settings.sttLanguage).toBe('en')
    store.setSttLanguage('pt')
    expect(store.getState().settings.sttLanguage).toBe('pt')

    const reloaded = createConversationStore({ storage })
    expect(reloaded.getState().settings.sttLanguage).toBe('pt')

    // A corrupted persisted value normalizes back to the default on load.
    const blob = JSON.parse(storage.dump[CONVERSATION_STORAGE_KEY])
    blob.settings.sttLanguage = 'klingon'
    storage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(blob))
    expect(createConversationStore({ storage }).getState().settings.sttLanguage).toBe('en')
  })

  it('persists to localStorage under a versioned key and restores on reload', () => {
    const store = createConversationStore({ storage, idFactory: () => 'x' })
    store.setProvider('anthropic')
    store.setModel('claude-opus-4-8')
    store.addUserTurn('remember me')
    store.appendAssistantDelta('done')
    store.finalizeAssistantTurn()

    // The versioned key exists and holds a version tag.
    expect(storage.dump[CONVERSATION_STORAGE_KEY]).toBeTruthy()
    expect(JSON.parse(storage.dump[CONVERSATION_STORAGE_KEY]).version).toBeGreaterThan(0)

    // A brand-new store over the SAME storage = a page reload.
    const reloaded = createConversationStore({ storage })
    expect(reloaded.getState().settings).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputMode: 'push-to-talk',
      sttMode: 'auto',
      sttLanguage: 'en',
      ttsEngine: 'web-speech',
      faceSkin: 'eidolon',
    })
    expect(reloaded.toMessages()).toEqual([
      { role: 'user', content: 'remember me' },
      { role: 'assistant', content: 'done' },
    ])
  })

  it('reset clears history (and persists the clear) but keeps provider/model', () => {
    const store = createConversationStore({ storage })
    store.setProvider('groq')
    store.addUserTurn('a')
    store.appendAssistantDelta('b')
    store.finalizeAssistantTurn()
    expect(store.getState().turns.length).toBe(2)

    store.reset()
    expect(store.getState().turns).toEqual([])
    expect(store.getState().settings.provider).toBe('groq')

    // Reload after reset stays empty (the clear was persisted).
    const reloaded = createConversationStore({ storage })
    expect(reloaded.getState().turns).toEqual([])
    expect(reloaded.getState().settings.provider).toBe('groq')
  })

  it('ignores a corrupt or version-mismatched persisted blob', () => {
    const bad = memoryStorage({ [CONVERSATION_STORAGE_KEY]: '{not json' })
    expect(() => createConversationStore({ storage: bad }).getState()).not.toThrow()
    expect(createConversationStore({ storage: bad }).getState().turns).toEqual([])

    const oldVersion = memoryStorage({
      [CONVERSATION_STORAGE_KEY]: JSON.stringify({ version: 0, turns: [{ role: 'user', content: 'x' }] }),
    })
    expect(createConversationStore({ storage: oldVersion }).getState().turns).toEqual([])
  })

  it('caps retained history so /api/chat bodies stay under the request cap', () => {
    const store = createConversationStore({ storage })
    const big = 'x'.repeat(50_000)
    // Add far more content than the cap allows.
    for (let i = 0; i < 60; i++) {
      store.addUserTurn(big)
      store.appendAssistantDelta(big)
      store.finalizeAssistantTurn()
    }
    const total = store
      .getState()
      .turns.reduce((n, t) => n + t.content.length, 0)
    expect(total).toBeLessThanOrEqual(MAX_HISTORY_CHARS)
    // The MOST RECENT turns survive; the oldest are dropped.
    expect(store.getState().turns.length).toBeGreaterThan(0)
  })

  it('notifies subscribers on change with a stable snapshot between mutations', () => {
    const store = createConversationStore({ storage })
    let calls = 0
    const unsub = store.subscribe(() => {
      calls++
    })
    const before = store.getState()
    expect(store.getState()).toBe(before) // stable reference, no mutation

    store.addUserTurn('hi')
    expect(calls).toBe(1)
    expect(store.getState()).not.toBe(before) // new immutable snapshot

    unsub()
    store.addUserTurn('again')
    expect(calls).toBe(1) // unsubscribed
  })

  it('appendAssistantDelta after a finalized turn starts a fresh assistant turn', () => {
    const store = createConversationStore({ storage })
    store.addUserTurn('u1')
    store.appendAssistantDelta('a1')
    store.finalizeAssistantTurn()
    // A stray delta with no intervening user turn opens a new pending turn.
    store.appendAssistantDelta('a2')
    store.finalizeAssistantTurn()
    expect(store.toMessages()).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'assistant', content: 'a2' },
    ])
  })
})
