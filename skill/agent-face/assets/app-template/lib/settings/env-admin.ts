// Server-env administration — the pure core behind POST/GET /api/env.
//
// Security contract (review, 2026-07-20 — every rule pinned by env-admin.test.ts):
//   • Fail-closed order: no-password → 404 · Vercel → 403 · transport → 403 ·
//     fetch-metadata → 403 · rate limit → 429 · bearer → 401 · content-type/size
//     → 415/413 · registry/value validation → 400 · only then touch anything.
//   • Secrets are write-only: no response or log line ever carries a value or
//     the presented password. Non-secret VALUES require a valid bearer.
//   • .env.local writes are atomic (same-dir tmp + rename) under an in-process
//     mutex, preserving unrelated lines; values are single-line and size-capped
//     (env-injection guard); names must be registry members.
//   • Changing a *_URL var clears its paired *_KEY unless a new key rides in
//     the same batch — otherwise a URL swap exfiltrates the old key.
//   • Persistence honesty: a var defined OUTSIDE .env.local (shell, Docker
//     env_file) reverts on restart — reported as 'live-until-restart'.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { ENV_REGISTRY, specFor } from './env-registry'

export type SettingsUnavailableReason =
  | 'no_password'
  | 'readonly_platform'
  | 'insecure_transport'
  | 'remote_disabled'

export interface SettingsAvailability {
  writable: boolean
  reason?: SettingsUnavailableReason
}

export interface EnvChange {
  name: string
  value: string | null
}

interface FsLike {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export interface EnvAdminDeps {
  env: Record<string, string | undefined>
  envFilePath: string
  fs?: FsLike
  now?: () => number
  log?: (line: string) => void
}

// --- password scheme ---------------------------------------------------------

const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1 }
const KEY_LEN = 32
const MAX_N = 1 << 17
const MAX_R = 16
const MAX_P = 4

const b64u = (buf: Buffer) => buf.toString('base64url')

/**
 * `scrypt:N:r:p:<salt b64url>:<hash b64url>` — params live in the string.
 * Colon-separated ON PURPOSE: @next/env runs dotenv-expansion on `.env.local`
 * values, and `$`-segments get eaten (a $-separated hash loaded back as
 * "scrypt6384" — live finding, 2026-07-20). Twin implementation:
 * skill/agent-face/scripts/settings-password.mjs (pinned by its parity test).
 */
export function hashPassword(
  password: string,
  params: { N: number; r: number; p: number } = SCRYPT_DEFAULTS,
  salt: Buffer = randomBytes(16),
): string {
  const derived = scryptSync(password, salt, KEY_LEN, {
    ...params,
    maxmem: 64 * 1024 * 1024,
  })
  return `scrypt:${params.N}:${params.r}:${params.p}:${b64u(salt)}:${b64u(derived)}`
}

/** Constant-time verify; malformed/tampered hashes return false, never throw. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split(':')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
    if (
      !Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) ||
      N < 2 || N > MAX_N || r < 1 || r > MAX_R || p < 1 || p > MAX_P
    ) {
      return false
    }
    const salt = Buffer.from(parts[4], 'base64url')
    const expected = Buffer.from(parts[5], 'base64url')
    if (salt.length === 0 || expected.length !== KEY_LEN) return false
    const derived = scryptSync(password, salt, KEY_LEN, { N, r, p, maxmem: 64 * 1024 * 1024 })
    return timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

// --- transport / platform classification ------------------------------------

function isVercel(env: Record<string, string | undefined>): boolean {
  return env.VERCEL === '1' || Boolean(env.VERCEL_ENV?.trim())
}

function isLocalHostname(host: string): boolean {
  const h = host.toLowerCase()
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '[::1]'
  )
}

function transportOf(request: Request): { local: boolean; https: boolean; host: string } {
  let host = ''
  let protocol = ''
  try {
    const u = new URL(request.url)
    host = u.hostname
    protocol = u.protocol
  } catch {
    // leave as remote/insecure
  }
  const https =
    request.headers.get('x-forwarded-proto') === 'https' || protocol === 'https:'
  return { local: isLocalHostname(host), https, host }
}

function passwordHashOf(env: Record<string, string | undefined>): string | null {
  const raw = env.FACE_SETTINGS_PASSWORD_HASH?.trim()
  return raw ? raw : null
}

/**
 * Whether settings writes are possible for THIS deployment + request. Also
 * consumed by /api/config to drive the GUI's read-only states. Booleans and
 * enum reasons only — never values.
 */
export function settingsAvailability(
  env: Record<string, string | undefined>,
  request: Request,
): SettingsAvailability {
  if (!passwordHashOf(env)) return { writable: false, reason: 'no_password' }
  if (isVercel(env)) return { writable: false, reason: 'readonly_platform' }
  const t = transportOf(request)
  if (t.local) return { writable: true }
  if (!t.https) return { writable: false, reason: 'insecure_transport' }
  if (env.FACE_SETTINGS_ALLOW_REMOTE !== '1') return { writable: false, reason: 'remote_disabled' }
  return { writable: true }
}

// --- .env.local merge --------------------------------------------------------

const LINE_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/**
 * Serialize a value for `.env.local` so @next/env loads it back VERBATIM:
 * `$` must be escaped (dotenv-expansion eats it even inside quotes) and `#`
 * or edge whitespace need quoting (unquoted `#` starts a comment). Values
 * containing `"` or `\` are rejected upstream (unserializable cleanly).
 */
function serializeEnvValue(value: string): string {
  const needsQuotes = /[#$]/.test(value) || /^\s|\s$/.test(value)
  if (!needsQuotes) return value
  return `"${value.replace(/\$/g, '\\$')}"`
}

/** Undo serializeEnvValue for comparison (strip quotes, unescape `\$`). */
function decodeEnvValue(raw: string): string {
  let v = raw
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1)
  }
  return v.replace(/\\\$/g, '$')
}

/** Parse KEY=value lines (comments/garbage ignored) — comparison only. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line.trim())
    if (m) out[m[1]] = decodeEnvValue(m[2])
  }
  return out
}

/**
 * Apply validated changes to the file text: upsert in place (first occurrence
 * wins, duplicates dropped), remove on null, append missing, preserve every
 * unrelated line byte-for-byte.
 */
export function applyChangesToFile(fileText: string, changes: EnvChange[]): string {
  let lines = fileText.split('\n')
  for (const change of changes) {
    const matches = (line: string) => {
      const m = LINE_RE.exec(line.trim())
      return m !== null && m[1] === change.name
    }
    let replaced = false
    lines = lines.filter((line, i) => {
      void i
      if (!matches(line)) return true
      if (change.value !== null && !replaced) {
        replaced = true
        return true
      }
      return false // drop removals and duplicate declarations
    })
    if (change.value !== null) {
      const serialized = `${change.name}=${serializeEnvValue(change.value)}`
      if (replaced) {
        lines = lines.map((line) => (matches(line) ? serialized : line))
      } else {
        // Append with trailing-newline discipline (file ends with one blank slot).
        if (lines.length > 0 && lines[lines.length - 1] === '') {
          lines.splice(lines.length - 1, 0, serialized)
        } else {
          lines.push(serialized)
        }
      }
    }
  }
  return lines.join('\n')
}

// --- validation --------------------------------------------------------------

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const MAX_VALUE_LEN = 4096
// Control characters (incl. \n \r) — the .env-injection guard.
const CONTROL_RE = /[\u0000-\u001f\u007f]/

function validateChange(change: unknown): { ok: true; change: EnvChange } | { ok: false; code: string; message: string } {
  if (
    !change || typeof change !== 'object' ||
    typeof (change as EnvChange).name !== 'string' ||
    !('value' in (change as object))
  ) {
    return { ok: false, code: 'bad_request', message: 'Each change needs {name, value|null}.' }
  }
  const { name, value } = change as EnvChange
  const spec = specFor(name)
  if (!NAME_RE.test(name) || !spec) {
    return { ok: false, code: 'unknown_var', message: `"${name}" is not an editable variable.` }
  }
  if (spec.readOnly) {
    return { ok: false, code: 'readonly_var', message: `"${name}" is deploy-time only.` }
  }
  if (value === null) return { ok: true, change: { name, value } }
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, code: 'invalid_value', message: `"${name}" needs a non-empty string or null.` }
  }
  if (CONTROL_RE.test(value)) {
    return { ok: false, code: 'invalid_value', message: `"${name}" value must be a single line.` }
  }
  if (value.includes('"') || value.includes('\\')) {
    return {
      ok: false,
      code: 'invalid_value',
      message: `"${name}" value cannot contain double quotes or backslashes (unserializable in .env.local).`,
    }
  }
  if (value.length > MAX_VALUE_LEN) {
    return { ok: false, code: 'invalid_value', message: `"${name}" value is too long.` }
  }
  if (spec.enum && !spec.enum.includes(value)) {
    return { ok: false, code: 'invalid_value', message: `"${name}" must be one of: ${spec.enum.join(', ')}.` }
  }
  const custom = spec.validate?.(value)
  if (custom) return { ok: false, code: 'invalid_value', message: `"${name}": ${custom}` }
  return { ok: true, change: { name, value } }
}

// --- responses ---------------------------------------------------------------

const NO_STORE = { 'cache-control': 'no-store' }

function err(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { code, message } }, { status, headers: { ...NO_STORE, ...headers } })
}

function envVarState(
  env: Record<string, string | undefined>,
  unlocked: boolean,
): Record<string, { set: boolean; value?: string }> {
  const out: Record<string, { set: boolean; value?: string }> = {}
  for (const spec of ENV_REGISTRY) {
    const raw = env[spec.name]
    const set = raw !== undefined && raw !== ''
    out[spec.name] = set && unlocked && !spec.secret ? { set, value: raw } : { set }
  }
  return out
}

// --- the admin ---------------------------------------------------------------

const BUCKET_CAPACITY = 5
const REFILL_MS = 20_000
const MAX_BODY = 16 * 1024

async function defaultReadFile(path: string): Promise<string> {
  const fs = await import('node:fs/promises')
  return fs.readFile(path, 'utf8')
}

const defaultFs: FsLike = {
  readFile: defaultReadFile,
  writeFile: async (p, d) => (await import('node:fs/promises')).writeFile(p, d, 'utf8'),
  rename: async (a, b) => (await import('node:fs/promises')).rename(a, b),
}

export function createEnvAdmin(deps: EnvAdminDeps) {
  const env = deps.env
  const fs = deps.fs ?? defaultFs
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.error(line))

  // Global (per-process) token bucket, consumed on auth FAILURE only.
  let tokens = BUCKET_CAPACITY
  let lastRefill = now()
  // In-process mutex: writes serialize on this chain.
  let writeLock: Promise<unknown> = Promise.resolve()

  function refill(): void {
    const elapsed = now() - lastRefill
    const earned = Math.floor(elapsed / REFILL_MS)
    if (earned > 0) {
      tokens = Math.min(BUCKET_CAPACITY, tokens + earned)
      lastRefill += earned * REFILL_MS
    }
  }

  /** 'ok' | 'fail' | 'none' — never reads the body. */
  function checkBearer(request: Request): 'ok' | 'fail' | 'none' {
    const header = request.headers.get('authorization') ?? ''
    if (!header.toLowerCase().startsWith('bearer ')) return 'none'
    const presented = header.slice(7)
    const stored = passwordHashOf(env)
    if (!stored) return 'fail'
    return verifyPassword(presented, stored) ? 'ok' : 'fail'
  }

  function auditContext(request: Request): string {
    const t = transportOf(request)
    return `host=${t.host || 'unknown'} proto=${t.https ? 'https' : 'http'}`
  }

  async function handleGet(request: Request): Promise<Response> {
    if (!passwordHashOf(env)) {
      // A LOCALHOST requester is the owner's own machine: reveal the first-run
      // bootstrap path (the GUI renders a create-password form). Remote
      // requesters keep seeing nothing — the fingerprinting cloak holds.
      const t = transportOf(request)
      if (t.local && !isVercel(env)) {
        return Response.json(
          {
            writable: false,
            reason: 'no_password',
            bootstrap: true,
            unlocked: false,
            vars: envVarState(env, false),
          },
          { headers: NO_STORE },
        )
      }
      return err(404, 'not_found', 'Not found.')
    }
    const availability = settingsAvailability(env, request)
    let unlocked = false
    const bearer = checkBearer(request)
    if (bearer !== 'none') {
      refill()
      if (tokens < 1) {
        return err(429, 'rate_limited', 'Too many attempts.', { 'retry-after': String(Math.ceil(REFILL_MS / 1000)) })
      }
      if (bearer === 'fail') {
        tokens -= 1
        log(`[settings] AUTH-FAIL get ${auditContext(request)} (${tokens}/${BUCKET_CAPACITY} tokens left)`)
        return err(401, 'unauthorized', 'Wrong settings password.', {
          'www-authenticate': 'Bearer realm="agent-faces-settings"',
        })
      }
      unlocked = true
    }
    return Response.json(
      { ...availability, unlocked, vars: envVarState(env, unlocked) },
      { headers: NO_STORE },
    )
  }

  async function handlePost(request: Request): Promise<Response> {
    // (1) Cloaked when the feature is unprovisioned.
    if (!passwordHashOf(env)) return err(404, 'not_found', 'Not found.')
    // (2) Platform that cannot persist — before auth (no password oracle).
    if (isVercel(env)) {
      return err(403, 'vercel_readonly', 'Env is managed in the Vercel dashboard; changes apply on redeploy.')
    }
    // (3) Transport.
    const t = transportOf(request)
    if (!t.local && !t.https) {
      return err(
        403,
        'insecure_transport',
        'Settings writes need HTTPS or localhost — the same tailscale-serve HTTPS URL that enables the microphone enables settings writes.',
      )
    }
    if (!t.local && t.https && env.FACE_SETTINGS_ALLOW_REMOTE !== '1') {
      return err(403, 'remote_disabled', 'Remote settings writes are disabled. Set FACE_SETTINGS_ALLOW_REMOTE=1 on the server to allow them over HTTPS.')
    }
    // (4) Fetch metadata, when a browser provides it.
    const site = request.headers.get('sec-fetch-site')
    if (site && site !== 'same-origin' && site !== 'none') {
      return err(403, 'cross_site', 'Cross-site settings writes are refused.')
    }
    // (5) Rate limit.
    refill()
    if (tokens < 1) {
      return err(429, 'rate_limited', 'Too many attempts.', { 'retry-after': String(Math.ceil(REFILL_MS / 1000)) })
    }
    // (6) Bearer — before the body is read.
    if (checkBearer(request) !== 'ok') {
      tokens -= 1
      log(`[settings] AUTH-FAIL write ${auditContext(request)} (${tokens}/${BUCKET_CAPACITY} tokens left)`)
      return err(401, 'unauthorized', 'Wrong settings password.', {
        'www-authenticate': 'Bearer realm="agent-faces-settings"',
      })
    }
    // (7) Content type. (8) Size.
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return err(415, 'unsupported_media_type', 'Send application/json.')
    }
    const text = await request.text()
    if (text.length > MAX_BODY) return err(413, 'payload_too_large', 'Body too large.')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return err(400, 'bad_request', 'Body must be JSON.')
    }
    const rawChanges = (parsed as { changes?: unknown }).changes
    if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
      return err(400, 'bad_request', 'Provide a non-empty "changes" array.')
    }
    // (9) Registry + value validation — whole batch atomic.
    const changes: EnvChange[] = []
    for (const raw of rawChanges) {
      const v = validateChange(raw)
      if (!v.ok) return err(400, v.code, v.message)
      changes.push(v.change)
    }
    // Paired-secret rule: a URL change without its key in the batch clears the key.
    const batchNames = new Set(changes.map((c) => c.name))
    for (const change of [...changes]) {
      const paired = specFor(change.name)?.pairedKey
      if (paired && !batchNames.has(paired)) {
        changes.push({ name: paired, value: null })
        batchNames.add(paired)
      }
    }
    // (10) Serialize the read-merge-write under the in-process mutex.
    const result = writeLock.then(async () => {
      let fileText = ''
      try {
        fileText = await fs.readFile(deps.envFilePath)
      } catch {
        fileText = ''
      }
      const fileVars = parseEnvFile(fileText)
      // Persistence honesty BEFORE mutation: defined outside .env.local ⇒ the
      // write can't survive a restart (initial-env precedence / Docker env_file).
      const persistence = new Map<string, 'persisted' | 'live-until-restart'>()
      for (const c of changes) {
        const liveValue = env[c.name]
        const definedOutsideFile = liveValue !== undefined && fileVars[c.name] !== liveValue
        persistence.set(c.name, definedOutsideFile ? 'live-until-restart' : 'persisted')
      }
      const nextText = applyChangesToFile(fileText, changes)
      const tmpPath = `${deps.envFilePath}.tmp`
      await fs.writeFile(tmpPath, nextText)
      await fs.rename(tmpPath, deps.envFilePath)
      for (const c of changes) {
        if (c.value === null) delete env[c.name]
        else env[c.name] = c.value
      }
      return changes.map((c) => ({
        name: c.name,
        restartTarget: specFor(c.name)!.restartTarget,
        persistence: persistence.get(c.name)!,
      }))
    })
    writeLock = result.catch(() => {})
    const applied = await result
    log(`[settings] WRITE ok vars=${applied.map((a) => a.name).join(',')} ${auditContext(request)}`)
    return Response.json(
      { ok: true, applied, vars: envVarState(env, true) },
      { headers: NO_STORE },
    )
  }

  /**
   * First-run password creation from the GUI — the no-terminal path (the
   * launcher's TTY prompt cannot run under non-TTY harnesses). Fail-closed:
   * LOCALHOST-only (never remote, regardless of FACE_SETTINGS_ALLOW_REMOTE),
   * never on Vercel, only while NO password exists (409 afterwards — the lock
   * can never be replaced through the door it guards).
   */
  async function handleBootstrap(request: Request): Promise<Response> {
    if (passwordHashOf(env)) {
      return err(409, 'already_provisioned', 'A settings password already exists. Rotation is CLI-only (settings-password.mjs).')
    }
    if (isVercel(env)) {
      return err(403, 'vercel_readonly', 'Env is managed in the Vercel dashboard.')
    }
    const t = transportOf(request)
    if (!t.local) {
      return err(403, 'local_only', 'The settings password can only be created from the machine running the server (localhost). Remote rigs: settings-password.mjs on that machine.')
    }
    const site = request.headers.get('sec-fetch-site')
    if (site && site !== 'same-origin' && site !== 'none') {
      return err(403, 'cross_site', 'Cross-site requests are refused.')
    }
    refill()
    if (tokens < 1) {
      return err(429, 'rate_limited', 'Too many attempts.', { 'retry-after': String(Math.ceil(REFILL_MS / 1000)) })
    }
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) {
      return err(415, 'unsupported_media_type', 'Send application/json.')
    }
    const text = await request.text()
    if (text.length > MAX_BODY) return err(413, 'payload_too_large', 'Body too large.')
    let password = ''
    try {
      password = String((JSON.parse(text) as { password?: unknown }).password ?? '')
    } catch {
      return err(400, 'bad_request', 'Body must be JSON.')
    }
    if (password.length < 12) {
      return err(400, 'invalid_value', 'The settings password needs at least 12 characters.')
    }
    const hash = hashPassword(password)
    const result = writeLock.then(async () => {
      let fileText = ''
      try {
        fileText = await fs.readFile(deps.envFilePath)
      } catch {
        fileText = ''
      }
      const nextText = applyChangesToFile(fileText, [
        { name: 'FACE_SETTINGS_PASSWORD_HASH', value: hash },
      ])
      const tmpPath = `${deps.envFilePath}.tmp`
      await fs.writeFile(tmpPath, nextText)
      await fs.rename(tmpPath, deps.envFilePath)
      env.FACE_SETTINGS_PASSWORD_HASH = hash
    })
    writeLock = result.catch(() => {})
    await result
    log(`[settings] BOOTSTRAP password created ${auditContext(request)}`)
    return Response.json({ ok: true }, { status: 201, headers: NO_STORE })
  }

  return { handleGet, handlePost, handleBootstrap }
}
