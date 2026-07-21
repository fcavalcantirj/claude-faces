// First-run settings-password creation — the no-terminal provisioning path.
// LOCALHOST-only, first-run-only (409 once a hash exists), never on Vercel.
// Shares the admin instance with /api/env so the rate bucket and write mutex
// span both endpoints. Full matrix in lib/settings/env-admin.ts.

import { envAdmin } from '../route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return envAdmin.handleBootstrap(request)
}
