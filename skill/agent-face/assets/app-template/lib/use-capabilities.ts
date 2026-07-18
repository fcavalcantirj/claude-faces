'use client'

// React binding for graceful degradation — the ONE hook the page calls on load
// to learn "what works here?" It fetches the secret-free `/api/config` probe,
// sniffs the browser's abilities, RECONCILES the persisted settings so no stale
// selection (a removed key, a vanished agent) leaves the app on a broken path,
// and returns the feature matrix the UI renders its hints from. All the decision
// logic lives in the pure, headlessly-tested `lib/capabilities.ts`; this shell
// just wires it to `fetch`, the browser globals, and the conversation store.
//
// It NEVER hard-fails: a failed probe falls back to `EMPTY_CONFIG` (chat off,
// local face on), and the face stays interactive regardless.

import { useEffect, useMemo, useState } from 'react'
import {
  EMPTY_CONFIG,
  computeFeatureMatrix,
  detectBrowserCapabilities,
  reconcileSettings,
  type BrowserCapabilities,
  type FeatureMatrix,
} from '@/lib/capabilities'
import type { AppConfig } from '@/lib/settings/panel-model'
import { getConversationStore } from '@/lib/use-conversation'
import type { ConversationStore } from '@/lib/conversation'

export interface UseCapabilities {
  /** The server capability probe (EMPTY_CONFIG until it loads / on failure). */
  config: AppConfig
  /** What the browser can physically do (WebGPU, mic, Web Speech, …). */
  browser: BrowserCapabilities
  /** The computed availability of chat / voice-in / voice-out with messages. */
  matrix: FeatureMatrix
  /** True while the first `/api/config` fetch is in flight. */
  loading: boolean
  /** Convenience: is any chat brain reachable right now? */
  hasBrain: boolean
}

export interface UseCapabilitiesOptions {
  /** Inject the config (tests/embeds) — skips the fetch entirely. */
  config?: AppConfig
  /** Injectable fetch (tests/embeds). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Inject the conversation store (defaults to the shared singleton). */
  store?: ConversationStore
}

/**
 * Probe capabilities once on mount and reconcile the persisted settings. After
 * the config resolves, any invalid selection (hosted STT with no key, OpenAI
 * voice with no key, a stale provider) is corrected in the store so the very
 * first spoken/typed turn uses a working path — without clobbering valid choices.
 */
export function useCapabilities(options: UseCapabilitiesOptions = {}): UseCapabilities {
  const store = options.store ?? getConversationStore()

  // Browser sniffing is synchronous + SSR-safe (all-false on the server); do it
  // once. `detectBrowserCapabilities()` reads `globalThis`.
  const browser = useMemo<BrowserCapabilities>(() => detectBrowserCapabilities(), [])

  const [config, setConfig] = useState<AppConfig>(options.config ?? EMPTY_CONFIG)
  const [loading, setLoading] = useState<boolean>(!options.config)

  // Load the capability probe once (unless config is injected). A failed fetch
  // degrades to EMPTY_CONFIG (chat off, local face on) — never a thrown UI.
  useEffect(() => {
    if (options.config) {
      setConfig(options.config)
      setLoading(false)
      return
    }
    const doFetch = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
    if (!doFetch) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    doFetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`config ${r.status}`))))
      .then((data: AppConfig) => {
        if (!cancelled) setConfig(data)
      })
      .catch(() => {
        // Keep EMPTY_CONFIG — the app stays a fully-local face and the matrix
        // explains that chat is off until a brain is reachable.
        if (!cancelled) setConfig(EMPTY_CONFIG)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [options.config, options.fetchImpl])

  // Reconcile persisted settings whenever the resolved config changes. Auto-pick
  // the zero-key local paths when no hosted key exists; repair invalid choices.
  useEffect(() => {
    const s = store.getState().settings
    const next = reconcileSettings(
      { provider: s.provider, sttMode: s.sttMode, ttsEngine: s.ttsEngine },
      config,
      browser,
    )
    const patch: Partial<typeof s> = {}
    if (next.provider !== s.provider) patch.provider = next.provider
    if (next.sttMode !== s.sttMode) patch.sttMode = next.sttMode
    if (next.ttsEngine !== s.ttsEngine) patch.ttsEngine = next.ttsEngine
    if (Object.keys(patch).length > 0) store.setSettings(patch)
  }, [config, browser, store])

  const matrix = useMemo(() => computeFeatureMatrix(config, browser), [config, browser])
  const hasBrain = matrix.chat.available

  return { config, browser, matrix, loading, hasBrain }
}
