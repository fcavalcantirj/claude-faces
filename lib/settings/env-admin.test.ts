import { describe, it, expect, vi } from 'vitest'
import {
  applyChangesToFile,
  createEnvAdmin,
  hashPassword,
  settingsAvailability,
  verifyPassword,
} from './env-admin'

// --- fakes -------------------------------------------------------------------

/** In-memory fs that records the operation order (atomicity assertions). */
function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const ops: string[] = []
  return {
    files,
    ops,
    async readFile(p: string) {
      ops.push(`read:${p}`)
      const v = files.get(p)
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return v
    },
    async writeFile(p: string, data: string) {
      ops.push(`write:${p}`)
      files.set(p, data)
    },
    async rename(from: string, to: string) {
      ops.push(`rename:${from}->${to}`)
      const v = files.get(from)
      if (v === undefined) throw new Error('rename ENOENT')
      files.set(to, v)
      files.delete(from)
    },
  }
}

const PW = 'correct horse battery'
const HASH = hashPassword(PW)
const FILE = '/fake/.env.local'

function makeAdmin(over: {
  env?: Record<string, string | undefined>
  file?: string
  now?: () => number
  log?: (l: string) => void
} = {}) {
  const env: Record<string, string | undefined> = {
    FACE_SETTINGS_PASSWORD_HASH: HASH,
    ...over.env,
  }
  const fs = memFs(over.file !== undefined ? { [FILE]: over.file } : {})
  const log = over.log ?? vi.fn()
  const admin = createEnvAdmin({
    env,
    envFilePath: FILE,
    fs,
    now: over.now ?? (() => 0),
    log,
  })
  return { admin, env, fs, log }
}

function post(body: unknown, opts: { url?: string; headers?: Record<string, string> } = {}) {
  return new Request(opts.url ?? 'http://localhost:3100/api/env', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${PW}`,
      ...opts.headers,
    },
    body: JSON.stringify(body),
  })
}

function get(opts: { url?: string; headers?: Record<string, string> } = {}) {
  return new Request(opts.url ?? 'http://localhost:3100/api/env', {
    method: 'GET',
    headers: opts.headers ?? {},
  })
}

const code = async (res: Response) => (await res.json())?.error?.code

// --- password scheme ---------------------------------------------------------

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords', () => {
    expect(verifyPassword(PW, HASH)).toBe(true)
    expect(verifyPassword('wrong', HASH)).toBe(false)
  })

  it('parses params from the stored string (not hardcoded)', () => {
    // A hash produced with different cost params must still verify.
    const weak = hashPassword(PW, { N: 4096, r: 8, p: 1 })
    expect(weak).toMatch(/^scrypt:4096:8:1:/)
    expect(verifyPassword(PW, weak)).toBe(true)
  })

  it('the format contains NO dollar signs — @next/env dotenv-expansion eats them', () => {
    // scrypt$16384$8$1$… loaded back as "scrypt6384" (verified live, 2026-07-20).
    expect(HASH).not.toContain('$')
  })

  it('malformed, tampered, or legacy-$-format hashes never verify and never throw', () => {
    for (const bad of [
      '',
      'plaintext',
      'scrypt:abc',
      'scrypt:16384:8:1:notb64:%%%',
      'scrypt$16384$8$1$AbC123$XyZ789', // the broken legacy format — re-provision
      HASH.slice(0, -4) + 'AAAA',
    ]) {
      expect(verifyPassword(PW, bad)).toBe(false)
    }
  })
})

// --- file merge --------------------------------------------------------------

describe('applyChangesToFile', () => {
  const FIXTURE = [
    '# agent-faces local env',
    'AGENT_BRIDGE_KIND=claude-code',
    'export GROQ_API_KEY=gsk_old',
    '',
    'OPENAI_API_KEY=sk-old',
    '# trailing comment',
  ].join('\n')

  it('upserts in place, appends missing, removes on null, preserves everything else', () => {
    const out = applyChangesToFile(FIXTURE, [
      { name: 'GROQ_API_KEY', value: 'gsk_new' },
      { name: 'OPENAI_API_KEY', value: null },
      { name: 'OPENROUTER_API_KEY', value: 'sk-or-new' },
    ])
    const lines = out.split('\n')
    expect(lines).toContain('GROQ_API_KEY=gsk_new') // export prefix normalized on rewrite
    expect(lines).not.toContain('export GROQ_API_KEY=gsk_old')
    expect(out).not.toMatch(/OPENAI_API_KEY/)
    expect(lines).toContain('OPENROUTER_API_KEY=sk-or-new')
    // untouched lines survive byte-for-byte
    expect(lines[0]).toBe('# agent-faces local env')
    expect(lines).toContain('AGENT_BRIDGE_KIND=claude-code')
    expect(lines).toContain('# trailing comment')
  })

  it('is idempotent for repeated writes of the same value', () => {
    const once = applyChangesToFile(FIXTURE, [{ name: 'GROQ_API_KEY', value: 'x' }])
    const twice = applyChangesToFile(once, [{ name: 'GROQ_API_KEY', value: 'x' }])
    expect(twice).toBe(once)
  })

  it('serializes $ and # values so @next/env loads them back verbatim', () => {
    const out = applyChangesToFile('', [
      { name: 'GROQ_API_KEY', value: 'gsk_with$dollar' },
      { name: 'OPENAI_TRANSCRIBE_PROMPT', value: 'names: Fugu #1, R$ prices' },
    ])
    // Dollar escaped (expansion guard), risky values double-quoted.
    expect(out).toContain('GROQ_API_KEY="gsk_with\\$dollar"')
    expect(out).toContain('OPENAI_TRANSCRIBE_PROMPT="names: Fugu #1, R\\$ prices"')
  })

  it('REGRESSION: hash line + risky values round-trip through the REAL @next/env loader', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'env-roundtrip-'))
    const KEYS = ['FACE_SETTINGS_PASSWORD_HASH', 'GROQ_API_KEY', 'OPENAI_TRANSCRIBE_PROMPT']
    const before = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    try {
      const fileText = applyChangesToFile(
        `FACE_SETTINGS_PASSWORD_HASH=${HASH}\n`,
        [
          { name: 'GROQ_API_KEY', value: 'gsk_with$dollar' },
          { name: 'OPENAI_TRANSCRIBE_PROMPT', value: 'has #hash and $dollar' },
        ],
      )
      // Under vitest NODE_ENV==='test', so @next/env reads .env.test.local and
      // SKIPS .env.local (dotenv convention) — same parser, test-mode filename.
      await writeFile(join(dir, '.env.local'), fileText)
      await writeFile(join(dir, '.env.test.local'), fileText)
      for (const k of KEYS) delete process.env[k]
      const { loadEnvConfig } = await import('@next/env')
      loadEnvConfig(dir, true, { info: () => {}, error: () => {} }, true, () => {})
      expect(process.env.FACE_SETTINGS_PASSWORD_HASH).toBe(HASH)
      expect(verifyPassword(PW, process.env.FACE_SETTINGS_PASSWORD_HASH!)).toBe(true)
      expect(process.env.GROQ_API_KEY).toBe('gsk_with$dollar')
      expect(process.env.OPENAI_TRANSCRIBE_PROMPT).toBe('has #hash and $dollar')
    } finally {
      for (const k of KEYS) {
        if (before[k] === undefined) delete process.env[k]
        else process.env[k] = before[k]
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// --- transport / platform availability ---------------------------------------

describe('settingsAvailability', () => {
  const t = (url: string, headers: Record<string, string> = {}) =>
    settingsAvailability(
      { FACE_SETTINGS_PASSWORD_HASH: HASH },
      new Request(url, { headers }),
    )

  it('no hash → not writable, no_password', () => {
    const a = settingsAvailability({}, new Request('http://localhost:3100/x'))
    expect(a).toEqual({ writable: false, reason: 'no_password' })
  })

  it('Vercel → readonly_platform even with a hash', () => {
    const a = settingsAvailability(
      { FACE_SETTINGS_PASSWORD_HASH: HASH, VERCEL: '1' },
      new Request('https://face.vercel.app/x'),
    )
    expect(a).toEqual({ writable: false, reason: 'readonly_platform' })
  })

  it('localhost over plain http → writable', () => {
    expect(t('http://localhost:3100/x').writable).toBe(true)
    expect(t('http://127.0.0.1:3100/x').writable).toBe(true)
  })

  it('remote host over plain http → insecure_transport (kills DNS rebinding too)', () => {
    expect(t('http://192.168.0.150:3100/x')).toEqual({
      writable: false,
      reason: 'insecure_transport',
    })
    expect(t('http://attacker.test:3100/x').reason).toBe('insecure_transport')
  })

  it('remote HTTPS needs FACE_SETTINGS_ALLOW_REMOTE=1', () => {
    expect(t('http://100.82.152.25:3100/x', { 'x-forwarded-proto': 'https' }).reason).toBe(
      'remote_disabled',
    )
    const allowed = settingsAvailability(
      { FACE_SETTINGS_PASSWORD_HASH: HASH, FACE_SETTINGS_ALLOW_REMOTE: '1' },
      new Request('http://100.82.152.25:3100/x', { headers: { 'x-forwarded-proto': 'https' } }),
    )
    expect(allowed.writable).toBe(true)
  })
})

// --- POST matrix -------------------------------------------------------------

describe('handlePost', () => {
  const CHANGE = { changes: [{ name: 'GROQ_API_KEY', value: 'gsk_test_value_123' }] }

  it('unprovisioned: POST 404s; LOCAL GET offers bootstrap; REMOTE GET stays cloaked', async () => {
    const { admin } = makeAdmin({ env: { FACE_SETTINGS_PASSWORD_HASH: undefined } })
    expect((await admin.handlePost(post(CHANGE))).status).toBe(404)
    // Localhost requester is the owner's machine — reveal the bootstrap path.
    const local = await admin.handleGet(get())
    expect(local.status).toBe(200)
    expect(await local.json()).toMatchObject({
      writable: false,
      reason: 'no_password',
      bootstrap: true,
    })
    // Remote requesters still see nothing (fingerprinting cloak).
    const remote = await admin.handleGet(get({ url: 'http://192.168.0.9:3100/api/env' }))
    expect(remote.status).toBe(404)
  })

  it('403 vercel_readonly before auth — and never touches the fs', async () => {
    const { admin, fs } = makeAdmin({ env: { VERCEL: '1' } })
    const res = await admin.handlePost(post(CHANGE, { headers: { authorization: 'Bearer nope' } }))
    expect(res.status).toBe(403)
    expect(await code(res)).toBe('vercel_readonly')
    expect(fs.ops.filter((o) => o.startsWith('write'))).toHaveLength(0)
  })

  it('transport truth-table', async () => {
    const { admin } = makeAdmin({ file: '' })
    // remote plain http → 403 before auth (rebinding shape included)
    const r1 = await admin.handlePost(post(CHANGE, { url: 'http://192.168.0.9:3100/api/env' }))
    expect([r1.status, await code(r1)]).toEqual([403, 'insecure_transport'])
    const r2 = await admin.handlePost(post(CHANGE, { url: 'http://attacker.test:3100/api/env' }))
    expect(await code(r2)).toBe('insecure_transport')
    // remote https without opt-in
    const r3 = await admin.handlePost(
      post(CHANGE, { url: 'http://100.1.2.3:3100/api/env', headers: { 'x-forwarded-proto': 'https' } }),
    )
    expect(await code(r3)).toBe('remote_disabled')
    // localhost plain http → allowed
    const r4 = await admin.handlePost(post(CHANGE))
    expect(r4.status).toBe(200)
  })

  it('remote https + FACE_SETTINGS_ALLOW_REMOTE=1 → allowed', async () => {
    const { admin } = makeAdmin({ env: { FACE_SETTINGS_ALLOW_REMOTE: '1' }, file: '' })
    const res = await admin.handlePost(
      post(CHANGE, { url: 'http://100.1.2.3:3100/api/env', headers: { 'x-forwarded-proto': 'https' } }),
    )
    expect(res.status).toBe(200)
  })

  it('Sec-Fetch-Site: cross-site refused; same-origin/none/absent pass', async () => {
    const { admin } = makeAdmin({ file: '' })
    const bad = await admin.handlePost(post(CHANGE, { headers: { 'sec-fetch-site': 'cross-site' } }))
    expect([bad.status, await code(bad)]).toEqual([403, 'cross_site'])
    for (const ok of ['same-origin', 'none']) {
      const res = await admin.handlePost(post(CHANGE, { headers: { 'sec-fetch-site': ok } }))
      expect(res.status).toBe(200)
    }
  })

  it('401 + WWW-Authenticate on wrong bearer; auth precedes body validation', async () => {
    const { admin } = makeAdmin({ file: '' })
    const res = await admin.handlePost(
      post({ changes: [{ name: 'NOT_IN_REGISTRY', value: 'x' }] }, { headers: { authorization: 'Bearer wrong' } }),
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/)
  })

  it('rate limit: 5 failures → 429 with Retry-After; refill recovers; success never consumes', async () => {
    let t = 0
    const { admin } = makeAdmin({ now: () => t, file: '' })
    for (let i = 0; i < 5; i++) {
      const r = await admin.handlePost(post(CHANGE, { headers: { authorization: 'Bearer no' } }))
      expect(r.status).toBe(401)
    }
    const limited = await admin.handlePost(post(CHANGE, { headers: { authorization: 'Bearer no' } }))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    // Even the CORRECT password is throttled while the bucket is empty.
    expect((await admin.handlePost(post(CHANGE))).status).toBe(429)
    t += 21_000 // one token refilled
    expect((await admin.handlePost(post(CHANGE))).status).toBe(200)
    // Successes do not consume: many in a row all pass.
    for (let i = 0; i < 4; i++) {
      expect((await admin.handlePost(post(CHANGE))).status).toBe(200)
    }
  })

  it('415 on wrong content type, 413 on oversized body', async () => {
    const { admin } = makeAdmin({ file: '' })
    const wrongType = new Request('http://localhost:3100/api/env', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${PW}` },
      body: 'GROQ_API_KEY=sneaky',
    })
    expect((await admin.handlePost(wrongType)).status).toBe(415)
    const huge = post({ changes: [{ name: 'GROQ_API_KEY', value: 'x'.repeat(20_000) }] })
    expect((await admin.handlePost(huge)).status).toBe(413)
  })

  it('registry validation: unknown, read-only, enum, url, multiline injection', async () => {
    const { admin, fs } = makeAdmin({ file: 'KEEP=1\n' })
    const cases: Array<[unknown, string]> = [
      [{ changes: [{ name: 'TOTALLY_UNKNOWN', value: 'x' }] }, 'unknown_var'],
      [{ changes: [{ name: 'FACE_SETTINGS_PASSWORD_HASH', value: 'x' }] }, 'unknown_var'],
      [{ changes: [{ name: 'SELF_HOST', value: '1' }] }, 'readonly_var'],
      [{ changes: [{ name: 'NEXT_PUBLIC_EVIL', value: 'x' }] }, 'unknown_var'],
      [{ changes: [{ name: 'AGENT_BRIDGE_KIND', value: 'not-a-kind' }] }, 'invalid_value'],
      [{ changes: [{ name: 'AGENT_BRIDGE_URL', value: 'not a url' }] }, 'invalid_value'],
      [{ changes: [{ name: 'GROQ_API_KEY', value: 'a\nSELF_HOST=1' }] }, 'invalid_value'],
      [{ changes: [{ name: 'GROQ_API_KEY', value: 'a\rB=1' }] }, 'invalid_value'],
      // Unserializable under dotenv quoting rules — honest refusal.
      [{ changes: [{ name: 'GROQ_API_KEY', value: 'has"quote' }] }, 'invalid_value'],
      [{ changes: [{ name: 'GROQ_API_KEY', value: 'back\\slash' }] }, 'invalid_value'],
    ]
    for (const [body, expected] of cases) {
      const res = await admin.handlePost(post(body))
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await code(res), JSON.stringify(body)).toBe(expected)
    }
    // A batch with one bad change writes NOTHING (atomic rejection).
    const mixed = await admin.handlePost(
      post({ changes: [{ name: 'GROQ_API_KEY', value: 'fine' }, { name: 'SELF_HOST', value: '1' }] }),
    )
    expect(mixed.status).toBe(400)
    expect(fs.files.get(FILE)).toBe('KEEP=1\n')
  })

  it('happy path: atomic tmp+rename write, live env mutation, GET reflects, persistence reported', async () => {
    const { admin, env, fs } = makeAdmin({ file: '# mine\n' })
    const res = await admin.handlePost(post(CHANGE))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.applied).toEqual([
      { name: 'GROQ_API_KEY', restartTarget: 'app', persistence: 'persisted' },
    ])
    // atomic: a tmp write then a rename onto the real path, no direct final write
    const writes = fs.ops.filter((o) => o.startsWith('write:'))
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toBe(`write:${FILE}`)
    expect(fs.ops.some((o) => o.startsWith('rename:') && o.endsWith(`->${FILE}`))).toBe(true)
    // live-apply + file content
    expect(env.GROQ_API_KEY).toBe('gsk_test_value_123')
    expect(fs.files.get(FILE)).toContain('GROQ_API_KEY=gsk_test_value_123')
    expect(fs.files.get(FILE)).toContain('# mine')
    // GET (unlocked) reflects presence; secrets never valued
    const g = await (await admin.handleGet(get({ headers: { authorization: `Bearer ${PW}` } }))).json()
    expect(g.unlocked).toBe(true)
    expect(g.vars.GROQ_API_KEY).toEqual({ set: true })
  })

  it('clearing a var removes it from file and live env', async () => {
    const { admin, env, fs } = makeAdmin({
      env: { GROQ_API_KEY: 'gsk_x' },
      file: 'GROQ_API_KEY=gsk_x\n',
    })
    const res = await admin.handlePost(post({ changes: [{ name: 'GROQ_API_KEY', value: null }] }))
    expect(res.status).toBe(200)
    expect(env.GROQ_API_KEY).toBeUndefined()
    expect(fs.files.get(FILE)).not.toContain('GROQ_API_KEY')
  })

  it('paired-secret rule: URL change without a new key clears the key; with one, sets both', async () => {
    const a = makeAdmin({
      env: { AGENT_BRIDGE_URL: 'http://old:1', AGENT_BRIDGE_KEY: 'oldkey' },
      file: 'AGENT_BRIDGE_URL=http://old:1\nAGENT_BRIDGE_KEY=oldkey\n',
    })
    const res = await a.admin.handlePost(
      post({ changes: [{ name: 'AGENT_BRIDGE_URL', value: 'http://evil:2' }] }),
    )
    expect(res.status).toBe(200)
    expect(a.env.AGENT_BRIDGE_KEY).toBeUndefined()
    expect(a.fs.files.get(FILE)).not.toContain('oldkey')

    const b = makeAdmin({
      env: { AGENT_BRIDGE_URL: 'http://old:1', AGENT_BRIDGE_KEY: 'oldkey' },
      file: 'AGENT_BRIDGE_URL=http://old:1\nAGENT_BRIDGE_KEY=oldkey\n',
    })
    const res2 = await b.admin.handlePost(
      post({
        changes: [
          { name: 'AGENT_BRIDGE_URL', value: 'http://new:2' },
          { name: 'AGENT_BRIDGE_KEY', value: 'newkey' },
        ],
      }),
    )
    expect(res2.status).toBe(200)
    expect(b.env.AGENT_BRIDGE_KEY).toBe('newkey')
  })

  it('reports live-until-restart when the var was defined OUTSIDE .env.local', async () => {
    // GROQ_API_KEY is in process.env but NOT in the file → shell/env_file origin.
    const { admin } = makeAdmin({ env: { GROQ_API_KEY: 'from-shell' }, file: '# empty\n' })
    const res = await admin.handlePost(post(CHANGE))
    const body = await res.json()
    expect(body.applied[0].persistence).toBe('live-until-restart')
  })

  it('never echoes a submitted value or password anywhere in the response', async () => {
    const { admin, log } = makeAdmin({ file: '' })
    const res = await admin.handlePost(post(CHANGE))
    const text = JSON.stringify(await res.json())
    expect(text).not.toContain('gsk_test_value_123')
    expect(text).not.toContain(PW)
    // Audit log lines carry names only.
    const logged = (log as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ')
    expect(logged).toContain('GROQ_API_KEY')
    expect(logged).not.toContain('gsk_test_value_123')
    expect(logged).not.toContain(PW)
  })
})

// --- bootstrap (first-run password creation from the GUI, localhost-only) ----

describe('handleBootstrap', () => {
  const boot = (password: string, opts: { url?: string; headers?: Record<string, string> } = {}) =>
    new Request(opts.url ?? 'http://localhost:3100/api/env/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify({ password }),
    })

  it('creates the password on a fresh LOCAL rig: writes the hash, then normal auth works', async () => {
    const { admin, env, fs } = makeAdmin({
      env: { FACE_SETTINGS_PASSWORD_HASH: undefined },
      file: '# fresh rig\n',
    })
    const res = await admin.handleBootstrap(boot('felipes new password'))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(JSON.stringify(body)).not.toContain('felipes new password')
    // Hash persisted (colon format) + live-applied.
    expect(fs.files.get(FILE)).toMatch(/FACE_SETTINGS_PASSWORD_HASH=scrypt:/)
    expect(fs.files.get(FILE)).toContain('# fresh rig')
    expect(env.FACE_SETTINGS_PASSWORD_HASH).toMatch(/^scrypt:/)
    // The editor now behaves as provisioned: GET writable, writes work.
    const g = await (await admin.handleGet(get())).json()
    expect(g.writable).toBe(true)
    const w = await admin.handlePost(
      new Request('http://localhost:3100/api/env', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer felipes new password',
        },
        body: JSON.stringify({ changes: [{ name: 'OPENAI_TTS_VOICE', value: 'echo' }] }),
      }),
    )
    expect(w.status).toBe(200)
  })

  it('409s when a password already exists — bootstrap is first-run only', async () => {
    const { admin, fs } = makeAdmin({ file: '' })
    expect((await admin.handleBootstrap(boot('another password 123'))).status).toBe(409)
    expect(fs.ops.filter((o) => o.startsWith('write'))).toHaveLength(0)
  })

  it('is LOCALHOST-only: remote origins are refused even over allowed HTTPS', async () => {
    const { admin } = makeAdmin({
      env: { FACE_SETTINGS_PASSWORD_HASH: undefined, FACE_SETTINGS_ALLOW_REMOTE: '1' },
    })
    const res = await admin.handleBootstrap(
      boot('remote attempt 12345', {
        url: 'http://100.82.152.25:3100/api/env/bootstrap',
        headers: { 'x-forwarded-proto': 'https' },
      }),
    )
    expect(res.status).toBe(403)
  })

  it('refused on Vercel; short passwords 400; cross-site 403; wrong content type 415', async () => {
    const vercel = makeAdmin({ env: { FACE_SETTINGS_PASSWORD_HASH: undefined, VERCEL: '1' } })
    expect((await vercel.admin.handleBootstrap(boot('long enough password'))).status).toBe(403)

    const { admin } = makeAdmin({ env: { FACE_SETTINGS_PASSWORD_HASH: undefined } })
    expect((await admin.handleBootstrap(boot('short'))).status).toBe(400)
    expect(
      (await admin.handleBootstrap(boot('long enough password', { headers: { 'sec-fetch-site': 'cross-site' } })))
        .status,
    ).toBe(403)
    const textPlain = new Request('http://localhost:3100/api/env/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ password: 'long enough password' }),
    })
    expect((await admin.handleBootstrap(textPlain)).status).toBe(415)
  })
})

// --- GET ---------------------------------------------------------------------

describe('handleGet', () => {
  it('locked: presence only, unlocked=false, writable truthfully reported', async () => {
    const { admin } = makeAdmin({ env: { GROQ_API_KEY: 'gsk_x', AGENT_BRIDGE_URL: 'http://b:1' } })
    const body = await (await admin.handleGet(get())).json()
    expect(body.writable).toBe(true)
    expect(body.unlocked).toBe(false)
    expect(body.vars.GROQ_API_KEY).toEqual({ set: true })
    expect(body.vars.AGENT_BRIDGE_URL).toEqual({ set: true }) // no value while locked
    expect(body.vars.ANTHROPIC_API_KEY).toEqual({ set: false })
    expect(JSON.stringify(body)).not.toContain('gsk_x')
  })

  it('unlocked: non-secret values appear; secrets stay presence-only', async () => {
    const { admin } = makeAdmin({ env: { GROQ_API_KEY: 'gsk_x', AGENT_BRIDGE_URL: 'http://b:1' } })
    const body = await (
      await admin.handleGet(get({ headers: { authorization: `Bearer ${PW}` } }))
    ).json()
    expect(body.unlocked).toBe(true)
    expect(body.vars.AGENT_BRIDGE_URL).toEqual({ set: true, value: 'http://b:1' })
    expect(body.vars.GROQ_API_KEY).toEqual({ set: true })
  })

  it('a wrong bearer on GET is a 401 (and consumes a rate token)', async () => {
    const { admin } = makeAdmin()
    const res = await admin.handleGet(get({ headers: { authorization: 'Bearer wrong' } }))
    expect(res.status).toBe(401)
  })
})
