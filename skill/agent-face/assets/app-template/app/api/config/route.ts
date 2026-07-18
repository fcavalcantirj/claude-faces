// The capability-probe route — the ONE place the browser asks "which brains,
// STT, and TTS are available in THIS deployment?" so the settings UI can offer
// only what works and preselect a sensible default. It returns BOOLEANS (and
// non-secret model ids) ONLY: never a key value or any partial secret. The
// client learns *whether* a capability exists here, never the credential.
//
// Availability is derived from the real adapter registry — the same
// `available(env)` used by `/api/chat` — plus simple key-presence checks for
// the STT/TTS keys that are not chat brains. Keeping this consistent with
// `docs/env-contract.md`, `.env.example`, and `check-env.mjs` is required.

import {
  listAdapters,
  selectDefaultAdapter,
  type ChatAdapter,
  type ProviderEnv,
} from '@/lib/providers'

// Reads process.env at request time (per-deployment env), so it must run on the
// Node runtime and never be statically pre-rendered.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The Mode B agent-bridge is surfaced separately from the Mode A brains. */
const AGENT_BRIDGE_ID = 'agent-bridge'

/** One Mode A brain's capability, as the settings picker consumes it. */
interface ProviderCapability {
  available: boolean
  label: string
  mode: 'A' | 'B'
  /** Present only when available: the model the picker should preselect. */
  defaultModel?: string
}

/** The secret-free capability surface the client renders the UI from. */
interface ConfigPayload {
  /** Mode A hosted brains keyed by id (anthropic / openrouter / groq / …). */
  providers: Record<string, ProviderCapability>
  /** Mode B bring-your-own running agent (reachable + permitted in this env). */
  agentBridge: { available: boolean; defaultModel?: string }
  /** Hosted speech-to-text keys (browser Whisper is always the zero-key path). */
  stt: { groq: boolean; openai: boolean }
  /** Hosted text-to-speech (Web Speech is always the zero-key path). */
  tts: { openai: boolean }
  /** The brain to preselect when the user has not picked one, or null if none. */
  defaultProvider: string | null
}

/**
 * Resolve to `undefined` (instead of hanging) if a promise takes too long. The
 * config probe must stay cheap; a slow provider catalog fetch must never block
 * the whole capability report.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | undefined) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), ms)
    // Don't keep a serverless invocation alive waiting on this timer.
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
    promise.then(
      (value) => {
        clearTimeout(timer)
        finish(value)
      },
      () => {
        clearTimeout(timer)
        finish(undefined)
      },
    )
  })
}

/**
 * The model id the picker should preselect for an adapter — its `isDefault`
 * model (falling back to the first). Best-effort: any failure or slowness (e.g.
 * a live catalog fetch) yields `undefined` rather than breaking the probe.
 */
async function defaultModelFor(
  adapter: ChatAdapter,
  env: ProviderEnv,
): Promise<string | undefined> {
  try {
    const models = await withTimeout(adapter.listModels(env), 1500)
    if (!models || models.length === 0) return undefined
    const chosen = models.find((m) => m.isDefault) ?? models[0]
    return chosen?.id
  } catch {
    return undefined
  }
}

export async function GET(): Promise<Response> {
  const env: ProviderEnv = process.env
  const adapters = listAdapters()

  const providers: Record<string, ProviderCapability> = {}
  let agentBridge: { available: boolean; defaultModel?: string } = { available: false }

  await Promise.all(
    adapters.map(async (adapter) => {
      const available = adapter.available(env)
      // Only pay the (cached, best-effort) listModels cost for available brains.
      const defaultModel = available ? await defaultModelFor(adapter, env) : undefined

      if (adapter.id === AGENT_BRIDGE_ID) {
        agentBridge = { available, ...(defaultModel ? { defaultModel } : {}) }
        return
      }

      providers[adapter.id] = {
        available,
        label: adapter.label,
        mode: adapter.mode,
        ...(defaultModel ? { defaultModel } : {}),
      }
    }),
  )

  // STT/TTS are plain key-presence checks — these keys are not chat brains, so
  // they are not in the registry. GROQ_API_KEY is dual-use (brain + Whisper).
  const stt = {
    groq: Boolean(env.GROQ_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
  }
  const tts = {
    openai: Boolean(env.OPENAI_API_KEY),
  }

  const defaultProvider = selectDefaultAdapter(env)?.id ?? null

  const payload: ConfigPayload = { providers, agentBridge, stt, tts, defaultProvider }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Cheap, secret-free capability probe. A short cache absorbs bursts while
      // still reflecting an env change / redeploy quickly.
      'cache-control': 'public, max-age=30, stale-while-revalidate=300',
    },
  })
}
