// The model-catalog route — the ONE place the settings picker asks "which
// models can THIS brain serve?" so the model dropdown is populated from the
// provider's real `listModels()` with the server default preselected. It runs
// `listModels(env)` SERVER-SIDE (some catalogs, like OpenRouter's live /models,
// need the key) and returns only non-secret ids/labels: never a credential.
//
// `?provider=<id>` selects the brain. An unknown id or a keyless/unreachable
// brain resolves to the same typed `AdapterError` the chat route uses, mapped to
// a machine-readable 400 so the UI can explain why the list is empty.

import {
  AdapterError,
  resolveAdapter,
  statusForAdapterError,
  type ChatAdapter,
  type ModelInfo,
  type ProviderEnv,
} from '@/lib/providers'

// Reads process.env (per-deployment keys) at request time, so it must run on the
// Node runtime and never be statically pre-rendered.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The secret-free catalog surface the picker renders the dropdown from. */
interface ModelsPayload {
  provider: string
  models: ModelInfo[]
  /** The id the dropdown should preselect (the adapter's default, else first). */
  default: string | null
}

/**
 * Resolve to `undefined` (instead of hanging) if a catalog fetch takes too long.
 * The picker must not block on a slow upstream /models call — degrade to no list.
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

export async function GET(request: Request): Promise<Response> {
  const env: ProviderEnv = process.env
  const url = new URL(request.url)
  const provider = (url.searchParams.get('provider') ?? '').trim()

  if (!provider) {
    return errorResponse(
      new AdapterError('bad_request', 'Missing "provider" query parameter.'),
    )
  }

  // Resolve the brain — unknown id or missing key/endpoint -> typed 400. This
  // guarantees we never call listModels() on an unavailable adapter.
  let adapter: ChatAdapter
  try {
    adapter = resolveAdapter(provider, env)
  } catch (err) {
    return errorResponse(err)
  }

  const models = (await withTimeout(adapter.listModels(env), 4000)) ?? []
  const chosen = models.find((m) => m.isDefault) ?? models[0]

  const payload: ModelsPayload = {
    provider,
    models,
    default: chosen?.id ?? null,
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Catalogs change rarely; a short cache absorbs repeated picker opens.
      'cache-control': 'public, max-age=60, stale-while-revalidate=300',
    },
  })
}

/** Serialize an error (typed or not) into the same JSON shape the chat route uses. */
function errorResponse(err: unknown): Response {
  const adapterError =
    err instanceof AdapterError
      ? err
      : new AdapterError('unknown', 'Failed to list models.')
  const status = statusForAdapterError(adapterError.code)
  // Clamp the client-abort code (499) to 400 for this non-streaming JSON path.
  const httpStatus = status === 499 ? 400 : status
  return new Response(JSON.stringify({ error: adapterError.toShape() }), {
    status: httpStatus,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}
