// The adapter registry — the single lookup table the `/api/chat` route and the
// `/api/config` probe go through. It maps a stable provider id to a factory and
// resolves ids to (memoized) `ChatAdapter` instances.
//
// THE SEAM, restated: adding a provider or wiring a new running agent is ONE
// file that implements `ChatAdapter` (lib/providers/<id>.ts) plus ONE
// `registerAdapter(...)` line in the "Built-in adapters" block below. Nothing
// else in the app changes — routes, settings, and config all read this table.

import {
  AdapterError,
  type ChatAdapter,
  type ChatAdapterFactory,
  type ProviderEnv,
} from '@/lib/providers/types'

/** id -> factory. Registration order does not matter; priority is explicit below. */
const factories = new Map<string, ChatAdapterFactory>()
/** id -> memoized instance (adapters are cheap, stateless singletons). */
const instances = new Map<string, ChatAdapter>()

/**
 * Register (or override) an adapter factory under its id. Adapter modules call
 * this at import time; tests call it to register a `FakeAdapter`. Overriding an
 * id clears any memoized instance so the new factory takes effect.
 */
export function registerAdapter(id: string, factory: ChatAdapterFactory): void {
  factories.set(id, factory)
  instances.delete(id)
}

/** Remove a registration (used by tests to clean up a `FakeAdapter`). */
export function unregisterAdapter(id: string): void {
  factories.delete(id)
  instances.delete(id)
}

/** Every registered adapter id, in the documented priority order first. */
export function registeredAdapterIds(): string[] {
  const ids = [...factories.keys()]
  return ids.sort((a, b) => priorityIndex(a) - priorityIndex(b))
}

/** Get an adapter instance by id, or `undefined` if none is registered. */
export function getAdapter(id: string): ChatAdapter | undefined {
  const factory = factories.get(id)
  if (!factory) return undefined
  let instance = instances.get(id)
  if (!instance) {
    instance = factory()
    instances.set(id, instance)
  }
  return instance
}

/**
 * Resolve an adapter by id for a request. Throws a typed `AdapterError` the
 * route maps to a 400 — `unknown_provider` if nothing is registered, or
 * `unavailable` if the adapter exists but its key/endpoint is missing.
 */
export function resolveAdapter(id: string, env: ProviderEnv = process.env): ChatAdapter {
  const adapter = getAdapter(id)
  if (!adapter) {
    throw new AdapterError('unknown_provider', `No brain registered under id "${id}".`, {
      provider: id,
    })
  }
  if (!adapter.available(env)) {
    throw new AdapterError(
      'unavailable',
      `The "${adapter.label}" brain is not configured (missing key or unreachable endpoint).`,
      { provider: id },
    )
  }
  return adapter
}

/** Every registered adapter instance (available or not), in priority order. */
export function listAdapters(): ChatAdapter[] {
  return registeredAdapterIds()
    .map((id) => getAdapter(id))
    .filter((a): a is ChatAdapter => a !== undefined)
}

/**
 * The adapters whose required server keys / reachable endpoints are present in
 * `env`, in priority order. This is what `/api/config` exposes (as booleans)
 * and what the settings picker offers.
 */
export function listAvailableAdapters(env: ProviderEnv = process.env): ChatAdapter[] {
  return listAdapters().filter((adapter) => adapter.available(env))
}

/**
 * The default brain when the user has not explicitly picked one: the first
 * available adapter in the documented priority order (Anthropic > OpenRouter >
 * Groq > agent-bridge). Returns `undefined` when no brain is configured.
 */
export function selectDefaultAdapter(env: ProviderEnv = process.env): ChatAdapter | undefined {
  return listAvailableAdapters(env)[0]
}

/**
 * Documented chat-brain priority (see docs/env-contract.md). Lower index wins.
 * Unknown ids (e.g. a test `FakeAdapter`) sort last but keep a stable order.
 */
const PRIORITY: readonly string[] = ['anthropic', 'openrouter', 'groq', 'agent-bridge']

function priorityIndex(id: string): number {
  const i = PRIORITY.indexOf(id)
  return i === -1 ? PRIORITY.length : i
}

// ---------------------------------------------------------------------------
// Built-in adapters
// ---------------------------------------------------------------------------
// Each concrete adapter registers itself here with a single line. Keep this
// block the ONE place built-in providers are wired up — nothing else in the
// app learns a provider's name.

import { createAnthropicAdapter } from '@/lib/providers/anthropic'

registerAdapter('anthropic', createAnthropicAdapter)

export {
  AdapterError,
  statusForAdapterError,
} from '@/lib/providers/types'
export type {
  ChatAdapter,
  ChatAdapterFactory,
  ChatRequest,
  ChatMessage,
  ModelInfo,
  StreamEvent,
  AdapterErrorCode,
  AdapterErrorShape,
  ProviderEnv,
} from '@/lib/providers/types'
