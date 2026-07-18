// Pure view-model for the settings panel — the headlessly-testable core that
// turns the secret-free `/api/config` capability probe into "what can the user
// pick, and why is the rest disabled?" The React drawer (`settings-panel.tsx`)
// is a thin shell over these functions; all the branching logic lives here so it
// is unit-tested with plain objects — no DOM, no fetch, no browser.
//
// The rules it encodes (kept consistent with docs/env-contract.md):
//   • Mode A brains are selectable only when the server reports a key present;
//     an unavailable brain stays visible but disabled with an explanation.
//   • The Mode B agent-bridge is shown ONLY when reachable/permitted in this env
//     (hidden entirely otherwise — a private localhost agent isn't offered on a
//     serverless deploy).
//   • STT `browser`/`auto` always work ($0 in-browser Whisper); `hosted` needs a
//     Groq or OpenAI key. TTS `web-speech`/`kokoro` always work (browser-local);
//     `openai` needs an OpenAI key. Both fall back gracefully when a key is gone.
//   • API keys are NEVER collected in the browser — an unavailable brain shows a
//     hint pointing at server-side env config, not a key field.

import type { SttMode } from '@/lib/stt'
import type { TtsEngine } from '@/lib/tts'
import type { FaceSkinId } from '@/lib/face/skin'

// --- The client-facing shape of the /api/config payload ---------------------
// (Mirrors app/api/config/route.ts's response — booleans + non-secret ids only.)

/** One Mode A brain's capability as the config probe reports it. */
export interface ProviderCapability {
  available: boolean
  label: string
  mode: 'A' | 'B'
  defaultModel?: string
}

/** The secret-free capability surface the panel renders from. */
export interface AppConfig {
  providers: Record<string, ProviderCapability>
  agentBridge: { available: boolean; defaultModel?: string }
  stt: { groq: boolean; openai: boolean }
  tts: { openai: boolean }
  defaultProvider: string | null
}

/** The agent-bridge is surfaced under its own key, not inside `providers`. */
export const AGENT_BRIDGE_ID = 'agent-bridge'
export const AGENT_BRIDGE_LABEL = 'Your running agent (bridge)'

// --- Brain (chat provider) options ------------------------------------------

/** A brain the picker can render: available -> selectable, else disabled + why. */
export interface BrainOption {
  id: string
  label: string
  mode: 'A' | 'B'
  available: boolean
  /** Why it can't be picked (only set when `available` is false). */
  disabledReason?: string
  /** True for the Mode B agent-bridge (rendered/hidden by different rules). */
  isAgentBridge: boolean
}

/** The env-config hint shown when a Mode A brain is unavailable. */
function providerHint(id: string): string {
  const key =
    id === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : id === 'openrouter'
        ? 'OPENROUTER_API_KEY'
        : id === 'groq'
          ? 'GROQ_API_KEY'
          : `${id.toUpperCase()}_API_KEY`
  return `Set ${key} on the server to enable this brain.`
}

/**
 * Build the brain list for the picker. Mode A providers come first (available
 * ones selectable, unavailable ones disabled with an env hint), then the Mode B
 * agent-bridge — but ONLY when it is reachable/permitted (hidden otherwise so a
 * private agent is never offered where it can't be reached).
 */
export function brainOptions(config: AppConfig): BrainOption[] {
  const options: BrainOption[] = []

  for (const [id, cap] of Object.entries(config.providers)) {
    options.push({
      id,
      label: cap.label,
      mode: cap.mode,
      available: cap.available,
      isAgentBridge: false,
      ...(cap.available ? {} : { disabledReason: providerHint(id) }),
    })
  }

  // The agent-bridge is shown only when reachable — hidden entirely otherwise.
  if (config.agentBridge.available) {
    options.push({
      id: AGENT_BRIDGE_ID,
      label: AGENT_BRIDGE_LABEL,
      mode: 'B',
      available: true,
      isAgentBridge: true,
    })
  }

  return options
}

/** Just the brains the user can actually select right now. */
export function selectableBrains(config: AppConfig): BrainOption[] {
  return brainOptions(config).filter((b) => b.available)
}

/**
 * Resolve which provider should be ACTIVE given the persisted selection and the
 * current config. A selection that is no longer available (key removed, agent
 * gone) falls back to the server-preferred default, then the first available
 * brain, then null (no brain configured — the UI explains that separately).
 */
export function resolveActiveProvider(
  selected: string | null,
  config: AppConfig,
): string | null {
  const available = new Set(selectableBrains(config).map((b) => b.id))
  if (selected && available.has(selected)) return selected
  if (config.defaultProvider && available.has(config.defaultProvider)) {
    return config.defaultProvider
  }
  const first = selectableBrains(config)[0]
  return first ? first.id : null
}

// --- STT / TTS / face-skin option availability ------------------------------

/** A pick-list entry: the value, whether it's selectable, and why not. */
export interface OptionAvailability<T extends string> {
  value: T
  label: string
  available: boolean
  reason?: string
}

const STT_LABELS: Record<SttMode, string> = {
  auto: 'Auto (browser first, hosted fallback)',
  browser: 'Browser Whisper (offline, private)',
  hosted: 'Hosted (Groq / OpenAI)',
}

/**
 * STT modes with availability. `browser`/`auto` always work (in-browser
 * Whisper needs no key); `hosted` needs a Groq or OpenAI key.
 */
export function sttModeOptions(config: AppConfig): OptionAvailability<SttMode>[] {
  const hostedKey = config.stt.groq || config.stt.openai
  return [
    { value: 'auto', label: STT_LABELS.auto, available: true },
    { value: 'browser', label: STT_LABELS.browser, available: true },
    {
      value: 'hosted',
      label: STT_LABELS.hosted,
      available: hostedKey,
      ...(hostedKey
        ? {}
        : { reason: 'Set GROQ_API_KEY or OPENAI_API_KEY on the server for hosted STT.' }),
    },
  ]
}

const TTS_LABELS: Record<TtsEngine, string> = {
  'web-speech': 'Web Speech (browser, no key)',
  openai: 'OpenAI gpt-4o-mini-tts (hosted)',
  kokoro: 'Kokoro-82M (local, WebGPU)',
}

/**
 * TTS engines with availability. `web-speech`/`kokoro` always work
 * (browser-local); `openai` needs an OpenAI key.
 */
export function ttsEngineOptions(config: AppConfig): OptionAvailability<TtsEngine>[] {
  const openai = config.tts.openai
  return [
    { value: 'web-speech', label: TTS_LABELS['web-speech'], available: true },
    {
      value: 'openai',
      label: TTS_LABELS.openai,
      available: openai,
      ...(openai
        ? {}
        : { reason: 'Set OPENAI_API_KEY on the server for OpenAI voice-out.' }),
    },
    { value: 'kokoro', label: TTS_LABELS.kokoro, available: true },
  ]
}

const SKIN_LABELS: Record<FaceSkinId, string> = {
  eidolon: 'EIDOLON particle face',
  talkinghead: 'TalkingHead avatar (stretch)',
}

/**
 * Face skins. Both are selectable — `talkinghead` degrades to `eidolon` at
 * runtime when its model isn't bundled (a console warning, not a crash), so we
 * don't hard-disable it here; we just flag it as the stretch option.
 */
export function faceSkinOptions(): OptionAvailability<FaceSkinId>[] {
  return [
    { value: 'eidolon', label: SKIN_LABELS.eidolon, available: true },
    { value: 'talkinghead', label: SKIN_LABELS.talkinghead, available: true },
  ]
}

/** True when no chat brain is configured at all — the UI shows a setup hint. */
export function hasNoBrain(config: AppConfig): boolean {
  return selectableBrains(config).length === 0
}
