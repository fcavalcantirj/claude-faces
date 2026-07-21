// Server-env editor endpoint — the thin HTTP shell over the pure, fully-tested
// admin core (lib/settings/env-admin.ts). One module-level admin instance so the
// rate-limit bucket and the write mutex span requests within the long-lived
// server process (localhost/self-host — the only place writes are possible).
//
// GET  → { writable, reason?, unlocked, vars } — presence inventory; non-secret
//        values only with a valid bearer. POST → guarded writes; see the
//        fail-closed matrix in env-admin.ts. Secrets never appear in responses.

import path from 'node:path'
import { createEnvAdmin } from '@/lib/settings/env-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Shared with ./bootstrap so rate limiting + the write mutex span both. */
export const envAdmin = createEnvAdmin({
  env: process.env,
  envFilePath: path.join(process.cwd(), '.env.local'),
})

export async function GET(request: Request): Promise<Response> {
  return envAdmin.handleGet(request)
}

export async function POST(request: Request): Promise<Response> {
  return envAdmin.handlePost(request)
}
