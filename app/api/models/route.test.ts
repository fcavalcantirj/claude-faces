import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/models/route'
import {
  registerAdapter,
  unregisterAdapter,
  type ChatAdapter,
  type ModelInfo,
} from '@/lib/providers'

// ---------------------------------------------------------------------------
// The /api/models route proxies an adapter's listModels() so the settings
// picker can populate the model dropdown. These specs register a FakeAdapter,
// then assert: (a) the catalog + preselected default come back for an available
// brain, (b) an unavailable/keyless brain is a typed 400 (never a catalog call),
// (c) an unknown provider is a typed 400, and (d) a missing provider param 400s.
// ---------------------------------------------------------------------------

const FAKE_ID = 'fake-models'

interface FakeOpts {
  available: boolean
  models: ModelInfo[]
}

function registerFake({ available, models }: FakeOpts): void {
  registerAdapter(FAKE_ID, (): ChatAdapter => ({
    id: FAKE_ID,
    label: 'Fake',
    mode: 'A',
    available: () => available,
    listModels: async () => models,
     
    async *streamChat() {
      throw new Error('not used')
    },
  }))
}

function req(url: string): Request {
  return new Request(url)
}

afterEach(() => {
  unregisterAdapter(FAKE_ID)
  vi.unstubAllEnvs()
})

describe('GET /api/models', () => {
  it('returns the catalog and preselects the default model for an available brain', async () => {
    registerFake({
      available: true,
      models: [
        { id: 'm-fast', label: 'Fast' },
        { id: 'm-best', label: 'Best', isDefault: true },
      ],
    })
    const res = await GET(req(`http://x/api/models?provider=${FAKE_ID}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBeTruthy()
    const body = await res.json()
    expect(body.provider).toBe(FAKE_ID)
    expect(body.models.map((m: ModelInfo) => m.id)).toEqual(['m-fast', 'm-best'])
    // isDefault wins the preselection.
    expect(body.default).toBe('m-best')
  })

  it('falls back to the first model when none is marked default', async () => {
    registerFake({ available: true, models: [{ id: 'only' }] })
    const res = await GET(req(`http://x/api/models?provider=${FAKE_ID}`))
    const body = await res.json()
    expect(body.default).toBe('only')
  })

  it('400s a keyless/unavailable brain WITHOUT listing models', async () => {
    const listModels = vi.fn(async () => [{ id: 'x' }])
    registerAdapter(FAKE_ID, (): ChatAdapter => ({
      id: FAKE_ID,
      label: 'Fake',
      mode: 'A',
      available: () => false,
      listModels,
       
      async *streamChat() {
        throw new Error('not used')
      },
    }))
    const res = await GET(req(`http://x/api/models?provider=${FAKE_ID}`))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('unavailable')
    // The route must never call listModels() on an unavailable adapter.
    expect(listModels).not.toHaveBeenCalled()
  })

  it('400s an unknown provider id', async () => {
    const res = await GET(req('http://x/api/models?provider=does-not-exist'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('unknown_provider')
  })

  it('400s a missing provider query parameter', async () => {
    const res = await GET(req('http://x/api/models'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('bad_request')
  })

  it('never leaks a key-like substring in the payload', async () => {
    registerFake({ available: true, models: [{ id: 'm', label: 'M' }] })
    const res = await GET(req(`http://x/api/models?provider=${FAKE_ID}`))
    const text = await res.text()
    expect(text).not.toMatch(/sk-|gsk-/)
  })
})
