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

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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

// Browser capabilities are STATIC facts about this page load, served through
// useSyncExternalStore so hydration is safe BY CONSTRUCTION: the server HTML
// and the hydration render both read the server snapshot (empty scope — all
// false, exactly what the server rendered), and React re-renders with the
// client snapshot only after hydration commits. Same two-pass timing as the
// old setState-in-effect approach, with no divergence window and no cascading
// render. Snapshots are cached at module scope because useSyncExternalStore
// requires referentially-stable results (a fresh object per call would loop).
const noopSubscribe = () => () => {}
let clientCaps: BrowserCapabilities | undefined
const getClientCaps = () => (clientCaps ??= detectBrowserCapabilities())
let serverCaps: BrowserCapabilities | undefined
const getServerCaps = () => (serverCaps ??= detectBrowserCapabilities({}))

/**
 * Probe capabilities once on mount and reconcile the persisted settings. After
 * the config resolves, any invalid selection (hosted STT with no key, OpenAI
 * voice with no key, a stale provider) is corrected in the store so the very
 * first spoken/typed turn uses a working path — without clobbering valid choices.
 */
export function useCapabilities(options: UseCapabilitiesOptions = {}): UseCapabilities {
  const store = options.store ?? getConversationStore()

  // Browser sniffing reads `globalThis`, which is EMPTY on the server but fully
  // populated in the browser — computing it during render once caused a real
  // hydration crash. See the note above the module-scope snapshots.
  const browser = useSyncExternalStore(noopSubscribe, getClientCaps, getServerCaps)

  // DERIVED config/loading: only the PROBED result is state; injection and the
  // EMPTY_CONFIG fallback resolve in the same render (the old effect mirrored
  // them into state one render late, a set-state-in-effect cascade).
  const [probed, setProbed] = useState<AppConfig | null>(null)
  const canFetch = Boolean(
    options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined),
  )
  const config = options.config ?? probed ?? EMPTY_CONFIG
  // SSR-safe: Node has a global fetch, so `canFetch` (hence `loading`) agrees
  // between the server render and the first client render.
  const loading = !options.config && canFetch && probed === null

  // Load the capability probe once (unless config is injected). A failed fetch
  // degrades to EMPTY_CONFIG (chat off, local face on) — never a thrown UI.
  useEffect(() => {
    if (options.config) return
    const doFetch = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
    if (!doFetch) return
    let cancelled = false
    doFetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`config ${r.status}`))))
      .then((data: AppConfig) => {
        if (!cancelled) setProbed(data)
      })
      .catch(() => {
        // Fall back to EMPTY_CONFIG — the app stays a fully-local face and the
        // matrix explains that chat is off until a brain is reachable.
        if (!cancelled) setProbed(EMPTY_CONFIG)
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
