// Thin-route glue tests ONLY. Deliberately NO happy-path write here: the route
// binds to the repo's real .env.local, and a test write would clobber the
// developer's own keys. The full write matrix (atomic tmp+rename, live-apply,
// paired-key clearing, persistence honesty) is covered by
// lib/settings/env-admin.test.ts against an injected in-memory fs.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from './route'
import { hashPassword } from '@/lib/settings/env-admin'

const PW = 'route-test-password'
const HASH = hashPassword(PW)

afterEach(() => {
  vi.unstubAllEnvs()
})

function get(headers: Record<string, string> = {}) {
  return new Request('http://localhost:3100/api/env', { method: 'GET', headers })
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3100/api/env', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('/api/env route', () => {
  it('unprovisioned: local GET offers bootstrap, POST is cloaked (404)', async () => {
    vi.stubEnv('FACE_SETTINGS_PASSWORD_HASH', '')
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ writable: false, reason: 'no_password', bootstrap: true })
    expect((await POST(post({ changes: [] }))).status).toBe(404)
  })

  it('bootstrap glue: 400 on a short password, 409 once provisioned (no fs writes here)', async () => {
    const { POST: BOOTSTRAP } = await import('./bootstrap/route')
    vi.stubEnv('FACE_SETTINGS_PASSWORD_HASH', '')
    const short = new Request('http://localhost:3100/api/env/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'short' }),
    })
    expect((await BOOTSTRAP(short)).status).toBe(400)
    vi.stubEnv('FACE_SETTINGS_PASSWORD_HASH', HASH)
    const again = new Request('http://localhost:3100/api/env/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'long enough password' }),
    })
    expect((await BOOTSTRAP(again)).status).toBe(409)
  })

  it('GET returns the presence inventory with no-store and no secret values', async () => {
    vi.stubEnv('FACE_SETTINGS_PASSWORD_HASH', HASH)
    vi.stubEnv('GROQ_API_KEY', 'gsk_route_test_secret')
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.writable).toBe(true)
    expect(body.unlocked).toBe(false)
    expect(body.vars.GROQ_API_KEY).toEqual({ set: true })
    expect(JSON.stringify(body)).not.toContain('gsk_route_test_secret')
  })

  it('POST with a wrong bearer is a 401 before any validation', async () => {
    vi.stubEnv('FACE_SETTINGS_PASSWORD_HASH', HASH)
    const res = await POST(
      post({ changes: [{ name: 'NOT_A_VAR', value: 'x' }] }, { authorization: 'Bearer wrong' }),
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/)
  })

  it('POST validation rejects unknown vars without touching the filesystem', async () => {
    vi.stubEnv('FACE_SETTINGS_PASSWORD_HASH', HASH)
    const res = await POST(
      post(
        { changes: [{ name: 'TOTALLY_UNKNOWN_VAR', value: 'x' }] },
        { authorization: `Bearer ${PW}` },
      ),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('unknown_var')
  })
})
