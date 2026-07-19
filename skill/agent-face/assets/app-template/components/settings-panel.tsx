'use client'

// The settings drawer — the ONE place the user configures the face: which brain
// answers, which model, how they talk to it (push-to-talk vs hands-free VAD),
// how it hears them (STT mode), how it speaks (TTS engine), and which face skin
// renders. It reads the SECRET-FREE `/api/config` probe to offer ONLY what the
// server can actually do (unavailable brains are shown but disabled, with a hint
// pointing at server-side env config — keys are NEVER collected in the browser),
// and the model dropdown is populated from the proxied `/api/models` catalog.
//
// Every choice persists through the conversation store (localStorage), so it
// survives a reload and — because the store is the single source of truth the
// orchestrator reads — takes effect immediately with no page refresh. All the
// "what's selectable and why" branching lives in the headlessly-tested pure
// view-model (`lib/settings/panel-model.ts`); this file is the thin UI shell.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelInfo } from '@/lib/providers'
import type { SttMode } from '@/lib/stt'
import type { TtsEngine } from '@/lib/tts'
import type { FaceSkinId } from '@/lib/face/skin'
import type { InputMode, SttLanguage } from '@/lib/conversation'
import { useConversation, type UseConversation } from '@/lib/use-conversation'
import {
  brainOptions,
  faceSkinOptions,
  hasNoBrain,
  resolveActiveProvider,
  sttModeOptions,
  ttsEngineOptions,
  type AppConfig,
} from '@/lib/settings/panel-model'

export interface SettingsPanelProps {
  /** Whether the drawer is visible. */
  open: boolean
  /** Close the drawer. */
  onClose: () => void
  /**
   * Injected capability config. When omitted the panel fetches `/api/config`
   * itself; injection is for embedding/tests where fetch isn't available.
   */
  config?: AppConfig | null
  /** Inject a conversation binding (defaults to the shared singleton store). */
  conversation?: UseConversation
  /** Injectable fetch (tests/embeds). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export function SettingsPanel({
  open,
  onClose,
  config: injectedConfig,
  conversation,
  fetchImpl,
}: SettingsPanelProps) {
  // Always call the hook (rules of hooks); prefer an injected binding's values.
  const hookConversation = useConversation()
  const conv = conversation ?? hookConversation
  const { settings } = conv.state

  const doFetch = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)

  // DERIVED, not mirrored: an injected config applies in the same render (the
  // old effect that copied the prop into state was one render late and tripped
  // the set-state-in-effect rule); only the fetched probe is state.
  const [fetchedConfig, setFetchedConfig] = useState<AppConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const config = injectedConfig ?? fetchedConfig

  // Fetched models are KEYED BY PROVIDER and derived against the active one, so
  // switching providers empties the list by derivation (no synchronous setState
  // in the effect's early return) and A's stale catalog never shows during B's
  // fetch.
  const [fetchedModels, setFetchedModels] = useState<{
    provider: string
    models: ModelInfo[]
  } | null>(null)

  // Load the capability probe once the drawer opens (unless config is injected).
  useEffect(() => {
    if (injectedConfig || !open || !doFetch) return
    let cancelled = false
    doFetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`config ${r.status}`))))
      .then((data: AppConfig) => {
        if (!cancelled) {
          setFetchedConfig(data)
          setConfigError(null)
        }
      })
      .catch(() => {
        if (!cancelled) setConfigError('Could not load server capabilities.')
      })
    return () => {
      cancelled = true
    }
  }, [open, injectedConfig, doFetch])

  const brains = useMemo(() => (config ? brainOptions(config) : []), [config])
  const activeProvider = useMemo(
    () => (config ? resolveActiveProvider(settings.provider, config) : settings.provider),
    [config, settings.provider],
  )

  const models = fetchedModels?.provider === activeProvider ? fetchedModels.models : []

  // Fetch the model catalog for the active provider (agent-bridge has no picker).
  useEffect(() => {
    if (!doFetch || !activeProvider || activeProvider === 'agent-bridge') return
    let cancelled = false
    doFetch(`/api/models?provider=${encodeURIComponent(activeProvider)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`models ${r.status}`))))
      .then((data: { models: ModelInfo[]; default: string | null }) => {
        if (cancelled) return
        setFetchedModels({ provider: activeProvider, models: data.models ?? [] })
        // Preselect the server default when the user hasn't chosen a valid model.
        const ids = new Set((data.models ?? []).map((m) => m.id))
        if ((!settings.model || !ids.has(settings.model)) && data.default) {
          conv.setModel(data.default)
        }
      })
      .catch(() => {
        if (!cancelled) setFetchedModels({ provider: activeProvider, models: [] })
      })
    return () => {
      cancelled = true
    }
    // settings.model intentionally omitted: we only re-fetch when the provider
    // changes, not on every model selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider, doFetch, conv])

  const onPickProvider = useCallback(
    (id: string) => {
      conv.setProvider(id)
      conv.setModel(null) // clear stale model; the effect preselects the new default
    },
    [conv],
  )

  if (!open) return null

  const stt = config ? sttModeOptions(config) : []
  const tts = config ? ttsEngineOptions(config) : []
  const skins = faceSkinOptions()
  const noBrain = config ? hasNoBrain(config) : false

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      className="fixed inset-0 z-50 flex justify-end font-mono"
    >
      {/* scrim */}
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <aside className="relative flex h-full w-full max-w-sm flex-col gap-6 overflow-y-auto border-l border-border/60 bg-background p-6 text-sm text-foreground">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-bold tracking-widest">SETTINGS</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border/60 px-2 py-1 text-xs tracking-wider text-muted-foreground hover:text-foreground"
          >
            CLOSE
          </button>
        </header>

        {configError ? (
          <p className="text-xs text-red-400">{configError}</p>
        ) : null}

        {/* Brain picker ------------------------------------------------------ */}
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] tracking-widest text-muted-foreground">BRAIN</h3>
          {noBrain ? (
            <p className="text-xs leading-relaxed text-amber-400">
              No chat brain is configured. Set a provider key (e.g.
              ANTHROPIC_API_KEY) on the server, or wire your running agent via
              AGENT_BRIDGE_URL, then reload.
            </p>
          ) : null}
          <div className="flex flex-col gap-1">
            {brains.map((b) => {
              const checked = activeProvider === b.id
              return (
                <label
                  key={b.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-sm border px-2 py-1.5 text-xs ${
                    checked ? 'border-current text-foreground' : 'border-border/40'
                  } ${b.available ? '' : 'cursor-not-allowed opacity-50'}`}
                >
                  <input
                    type="radio"
                    name="brain"
                    className="mt-0.5"
                    checked={checked}
                    disabled={!b.available}
                    onChange={() => onPickProvider(b.id)}
                  />
                  <span className="flex flex-col">
                    <span className="tracking-wider">
                      {b.label}
                      <span className="ml-1 text-muted-foreground/50">
                        · mode {b.mode}
                      </span>
                    </span>
                    {b.disabledReason ? (
                      <span className="text-[10px] text-muted-foreground/70">
                        {b.disabledReason}
                      </span>
                    ) : null}
                  </span>
                </label>
              )
            })}
          </div>

          {/* Model dropdown (Mode A providers only) */}
          {activeProvider && activeProvider !== 'agent-bridge' && models.length > 0 ? (
            <label className="mt-1 flex flex-col gap-1">
              <span className="text-[11px] tracking-widest text-muted-foreground">
                MODEL
              </span>
              <select
                value={settings.model ?? ''}
                onChange={(e) => conv.setModel(e.target.value || null)}
                className="rounded-sm border border-border/60 bg-card px-2 py-1.5 text-xs"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {(m.label ?? m.id) + (m.isDefault ? ' (default)' : '')}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </section>

        {/* Input mode ------------------------------------------------------- */}
        <Segmented<InputMode>
          title="INPUT"
          value={settings.inputMode}
          onChange={(v) => conv.setInputMode(v)}
          options={[
            { value: 'push-to-talk', label: 'Push-to-talk' },
            { value: 'hands-free', label: 'Hands-free (VAD)' },
          ]}
        />

        {/* STT mode --------------------------------------------------------- */}
        <RadioGroup<SttMode>
          title="SPEECH-TO-TEXT"
          value={settings.sttMode}
          onChange={(v) => conv.setSttMode(v)}
          options={stt}
        />

        {/* Voice language ---------------------------------------------------
            Whisper's per-clip auto-detect misreads accented speech, so English
            is pinned by default; Auto re-enables per-clip detection. */}
        <Segmented<SttLanguage>
          title="VOICE LANGUAGE"
          value={settings.sttLanguage}
          onChange={(v) => conv.setSttLanguage(v)}
          options={[
            { value: 'en', label: 'English' },
            { value: 'auto', label: 'Auto' },
          ]}
        />

        {/* TTS engine ------------------------------------------------------- */}
        <RadioGroup<TtsEngine>
          title="VOICE (TTS)"
          value={settings.ttsEngine}
          onChange={(v) => conv.setTtsEngine(v)}
          options={tts}
        />

        {/* Face skin -------------------------------------------------------- */}
        <RadioGroup<FaceSkinId>
          title="FACE SKIN"
          value={settings.faceSkin}
          onChange={(v) => conv.setFaceSkin(v)}
          options={skins}
        />

        <footer className="mt-auto border-t border-border/40 pt-3 text-[10px] leading-relaxed text-muted-foreground/70">
          Provider API keys stay on the server and are never entered here.
          Unavailable options need the matching env key set server-side. Voice,
          STT, and face changes take effect immediately and survive a reload.
        </footer>
      </aside>
    </div>
  )
}

// --- Small internal controls ------------------------------------------------

interface OptionLike<T extends string> {
  value: T
  label: string
  available?: boolean
  reason?: string
}

/** A labelled radio group; disabled options show their reason. */
function RadioGroup<T extends string>({
  title,
  value,
  onChange,
  options,
}: {
  title: string
  value: T
  onChange: (value: T) => void
  options: OptionLike<T>[]
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] tracking-widest text-muted-foreground">{title}</h3>
      <div className="flex flex-col gap-1">
        {options.map((o) => {
          const disabled = o.available === false
          return (
            <label
              key={o.value}
              className={`flex cursor-pointer items-start gap-2 text-xs ${
                disabled ? 'cursor-not-allowed opacity-50' : ''
              }`}
            >
              <input
                type="radio"
                name={title}
                className="mt-0.5"
                checked={value === o.value}
                disabled={disabled}
                onChange={() => onChange(o.value)}
              />
              <span className="flex flex-col">
                <span className="tracking-wider">{o.label}</span>
                {o.reason ? (
                  <span className="text-[10px] text-muted-foreground/70">{o.reason}</span>
                ) : null}
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

/** A compact two-or-more-way segmented toggle. */
function Segmented<T extends string>({
  title,
  value,
  onChange,
  options,
}: {
  title: string
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[11px] tracking-widest text-muted-foreground">{title}</h3>
      <div className="flex gap-1">
        {options.map((o) => {
          const active = value === o.value
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              aria-pressed={active}
              className={`flex-1 rounded-sm border px-2 py-1.5 text-xs tracking-wider transition-colors ${
                active
                  ? 'border-current bg-card text-foreground'
                  : 'border-border/40 text-muted-foreground hover:text-foreground'
              }`}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}
