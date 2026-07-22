'use client'

// The SERVER ENV view of the settings drawer — the first place in the app that
// EDITS server-side env (keys, bridge wires, knobs) instead of just explaining
// it. Talks to the guarded /api/env endpoint; the master password is held in
// component memory only (never storage), values of SECRET vars are write-only
// forever, and every non-writable state renders the honest reason + remedy.
// Ordering follows lib/settings/panel-model.serverEnvRows: used-first, then
// unset essentials, SHOW ALL for the rest.

import { useCallback, useEffect, useRef, useState } from 'react'
import { serverEnvRows } from '@/lib/settings/panel-model'
import type { EnvVarSpec } from '@/lib/settings/env-registry'

interface EnvInventory {
  writable: boolean
  reason?: string
  /** True on an unprovisioned rig when the requester is localhost (first run). */
  bootstrap?: boolean
  unlocked: boolean
  vars: Record<string, { set: boolean; value?: string }>
}

interface AppliedChange {
  name: string
  restartTarget: 'app' | 'bridge'
  persistence: 'persisted' | 'live-until-restart'
}

export interface ServerEnvPanelProps {
  onBack: () => void
  /** Fired after any successful save so config consumers can refresh. */
  onSaved?: () => void
  fetchImpl?: typeof fetch
}

const REASON_GUIDANCE: Record<string, string> = {
  no_password:
    'No settings password is provisioned on THIS server. The launcher (start.mjs) auto-generates one on first run and prints it ONCE in its output — check the launcher logs, or ask whoever deployed this rig for it. Otherwise: from the machine running it, open http://localhost:<port> and create one right here in SERVER ENV — or generate a FACE_SETTINGS_PASSWORD_HASH line with node skill/agent-face/scripts/settings-password.mjs and add it to that machine’s .env.local, then restart.',
  readonly_platform:
    'Read-only here: on Vercel, env vars are managed in your project dashboard (Settings → Environment Variables); changes apply on redeploy.',
  insecure_transport:
    'This address is plain http:// on a non-localhost host, so writes are refused. Open the face on localhost — or over the same tailscale-serve HTTPS URL that enables the microphone.',
  remote_disabled:
    'Remote editing is disabled. Set FACE_SETTINGS_ALLOW_REMOTE=1 on the server to allow settings writes over HTTPS.',
}

function savedMessage(applied: AppliedChange[]): string {
  const a = applied[0]
  if (!a) return 'saved'
  const restart = a.restartTarget === 'bridge' ? ' — applies after a launcher restart' : ' — live now'
  const persistence =
    a.persistence === 'live-until-restart'
      ? ' (set outside .env.local: reverts on restart — move it into .env.local on the host to keep it)'
      : ''
  return `saved${restart}${persistence}`
}

export function ServerEnvPanel({ onBack, onSaved, fetchImpl }: ServerEnvPanelProps) {
  const doFetch = fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)

  const [inventory, setInventory] = useState<EnvInventory | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // The accepted password lives in memory for this page load only.
  const [password, setPassword] = useState('')
  // Ref mirror: the bootstrap retry loop must see unlock's success immediately
  // (the state value inside its closure is stale by design of closures).
  const passwordRef = useRef('')
  const [draftPassword, setDraftPassword] = useState('')
  const [draftConfirm, setDraftConfirm] = useState('')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [rowMsg, setRowMsg] = useState<{ name: string; text: string; error: boolean } | null>(null)

  // Mount probe — inline promise chain (the house set-state-in-.then pattern;
  // a synchronous setState in the effect body trips the compiler lint).
  useEffect(() => {
    if (!doFetch) return
    let cancelled = false
    doFetch('/api/env', { cache: 'no-store' })
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) {
          setInventory({ writable: false, reason: 'no_password', unlocked: false, vars: {} })
          return
        }
        if (!res.ok) throw new Error(`env ${res.status}`)
        const body = (await res.json()) as EnvInventory
        if (!cancelled) {
          setInventory(body)
          setLoadError(null)
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError('Could not load the server env inventory.')
      })
    return () => {
      cancelled = true
    }
  }, [doFetch])

  // Unlock — event-handler only (the password never rides a mount request).
  const unlock = useCallback(
    async (bearer: string) => {
      if (!doFetch) return
      try {
        const res = await doFetch('/api/env', {
          cache: 'no-store',
          headers: { authorization: `Bearer ${bearer}` },
        })
        if (res.status === 401) {
          setUnlockError('Wrong password.')
          return
        }
        if (res.status === 429) {
          setUnlockError('Too many attempts — wait a moment and try again.')
          return
        }
        if (!res.ok) throw new Error(`env ${res.status}`)
        const body = (await res.json()) as EnvInventory
        setInventory(body)
        if (body.unlocked) {
          setPassword(bearer)
          passwordRef.current = bearer
          setUnlockError(null)
          setDraftPassword('')
        }
      } catch {
        setUnlockError('Could not reach the server.')
      }
    },
    [doFetch],
  )

  const save = useCallback(
    async (name: string, value: string | null) => {
      if (!doFetch || !password) return
      setBusy(true)
      setRowMsg(null)
      try {
        const res = await doFetch('/api/env', {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${password}`,
          },
          body: JSON.stringify({ changes: [{ name, value }] }),
        })
        const body = await res.json().catch(() => null)
        if (!res.ok) {
          const message = body?.error?.message ?? `Save failed (${res.status}).`
          setRowMsg({ name, text: message, error: true })
          return
        }
        setInventory((prev) =>
          prev ? { ...prev, unlocked: true, vars: body.vars } : prev,
        )
        setRowMsg({ name, text: savedMessage(body.applied ?? []), error: false })
        setEditing(null)
        setDraftValue('')
        onSaved?.()
      } catch {
        setRowMsg({ name, text: 'Save failed — is the server reachable?', error: true })
      } finally {
        setBusy(false)
      }
    },
    [doFetch, password, onSaved],
  )

  // First-run: create the password right here (localhost-only; server-enforced).
  const bootstrap = useCallback(
    async (pw: string, confirm: string) => {
      if (!doFetch) return
      if (pw !== confirm) {
        setUnlockError('Passwords do not match.')
        return
      }
      try {
        const res = await doFetch('/api/env/bootstrap', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          setUnlockError(body?.error?.message ?? `Could not create the password (${res.status}).`)
          return
        }
        setUnlockError(null)
        // Provisioned — unlock in one motion. The .env.local write can make the
        // DEV server hot-restart, so the first unlock may race it: retry.
        for (let attempt = 0; attempt < 5; attempt++) {
          await unlock(pw)
          if (passwordRef.current) return
          await new Promise((r) => setTimeout(r, 900))
        }
        setUnlockError(
          'Password created. The server is reloading — type it in the unlock box in a few seconds.',
        )
      } catch {
        setUnlockError('Could not reach the server.')
      }
    },
    [doFetch, unlock],
  )

  const rows = serverEnvRows(inventory?.vars)
  const unlocked = Boolean(password) && Boolean(inventory?.unlocked || password)
  const writable = inventory?.writable ?? false
  const canBootstrap = Boolean(inventory?.bootstrap) && !writable
  const guidance =
    inventory && !writable && !canBootstrap ? REASON_GUIDANCE[inventory.reason ?? ''] : null
  // Mirror the server's transport rule client-side: never offer a password
  // field where the password would travel in the clear to a remote host.
  const secureHere =
    typeof window === 'undefined' ||
    window.isSecureContext ||
    window.location.hostname === 'localhost'

  const renderRow = (spec: EnvVarSpec, readOnly = false) => {
    const state = inventory?.vars[spec.name]
    const set = Boolean(state?.set)
    const isEditing = editing === spec.name
    const msg = rowMsg?.name === spec.name ? rowMsg : null
    return (
      <div key={spec.name} className="flex flex-col gap-1 border-b border-border/30 pb-2">
        <div className="flex items-start justify-between gap-2">
          <span className="flex flex-col">
            <span className="text-xs tracking-wider">{spec.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground/60">{spec.name}</span>
          </span>
          <span className="flex items-center gap-2">
            <span
              className={`text-[10px] tracking-widest ${set ? 'text-emerald-400' : 'text-muted-foreground/50'}`}
            >
              {set ? '● SET' : '○ NOT SET'}
            </span>
            {!readOnly && unlocked && writable ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(isEditing ? null : spec.name)
                    setDraftValue(!spec.secret && state?.value ? state.value : '')
                    setRowMsg(null)
                  }}
                  className="cursor-pointer rounded-sm border border-border/60 px-2 py-0.5 text-[10px] tracking-wider text-muted-foreground transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent"
                >
                  {set ? 'EDIT' : 'SET'}
                </button>
                {set ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void save(spec.name, null)}
                    className="cursor-pointer rounded-sm border border-border/60 px-2 py-0.5 text-[10px] tracking-wider text-muted-foreground transition-colors hover:border-red-400 hover:bg-red-950/40 hover:text-red-400"
                  >
                    CLEAR
                  </button>
                ) : null}
              </>
            ) : null}
          </span>
        </div>
        {!spec.secret && unlocked && state?.value && !isEditing ? (
          <span className="truncate font-mono text-[10px] text-muted-foreground">{state.value}</span>
        ) : null}
        {isEditing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (draftValue) void save(spec.name, draftValue)
            }}
          >
            {spec.enum ? (
              <select
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                className="flex-1 rounded-sm border border-border/60 bg-card px-2 py-1.5 text-xs"
              >
                <option value="">pick…</option>
                {spec.enum.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={spec.secret ? 'password' : 'text'}
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                placeholder={
                  spec.secret
                    ? set
                      ? 'current value hidden — type a NEW one to replace it'
                      : 'value stays on the server'
                    : 'value'
                }
                autoComplete="off"
                className="flex-1 rounded-sm border border-border/60 bg-card px-3 py-2 font-mono text-xs placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none"
              />
            )}
            <button
              type="submit"
              disabled={busy || !draftValue}
              className="cursor-pointer rounded-sm border border-border/60 px-2 py-1 text-[10px] tracking-wider transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent disabled:opacity-40"
            >
              SAVE
            </button>
          </form>
        ) : null}
        {isEditing && spec.secret ? (
          <span className="text-[10px] text-muted-foreground/60">
            Write-only by design: the current value never leaves the server, for anyone.
          </span>
        ) : null}
        {spec.help?.length || spec.docsUrl ? (
          <details className="text-[10px] leading-relaxed text-muted-foreground/70">
            <summary className="cursor-pointer">how to get this</summary>
            <div className="mt-1 flex flex-col gap-0.5">
              {spec.help?.map((line) => <span key={line}>{line}</span>)}
              {spec.docsUrl ? (
                <a
                  href={spec.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  {spec.docsUrl}
                </a>
              ) : null}
            </div>
          </details>
        ) : null}
        {msg ? (
          <span className={`text-[10px] ${msg.error ? 'text-red-400' : 'text-emerald-400'}`}>
            {msg.text}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer rounded-sm border border-border/60 px-2 py-1 text-xs tracking-wider text-muted-foreground transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent"
        >
          ← SETTINGS
        </button>
        <h3 className="text-[11px] tracking-widest text-muted-foreground">SERVER ENV</h3>
      </header>

      {loadError ? <p className="text-xs text-red-400">{loadError}</p> : null}

      {guidance ? (
        <p className="text-xs leading-relaxed text-amber-400">{guidance}</p>
      ) : null}

      {canBootstrap ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (draftPassword) void bootstrap(draftPassword, draftConfirm)
          }}
        >
          <p className="text-xs leading-relaxed text-amber-400">
            First run: create the settings password for THIS server. It guards
            every env edit here (stored as a hash in .env.local — localhost only).
          </p>
          <input
            type="password"
            value={draftPassword}
            onChange={(e) => setDraftPassword(e.target.value)}
            placeholder="new settings password (min 12 chars)"
            autoComplete="new-password"
            className="rounded-sm border border-border/60 bg-card px-3 py-2 font-mono text-xs placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none"
          />
          <input
            type="password"
            value={draftConfirm}
            onChange={(e) => setDraftConfirm(e.target.value)}
            placeholder="repeat it"
            autoComplete="new-password"
            className="rounded-sm border border-border/60 bg-card px-3 py-2 font-mono text-xs placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none"
          />
          {/* A silently-disabled button reads as broken — always say WHY. */}
          {draftPassword.length > 0 && draftPassword.length < 12 ? (
            <span className="text-[10px] text-amber-400">
              {12 - draftPassword.length} more character
              {12 - draftPassword.length === 1 ? '' : 's'} needed (12 minimum).
            </span>
          ) : draftPassword.length >= 12 && draftConfirm.length > 0 && draftPassword !== draftConfirm ? (
            <span className="text-[10px] text-amber-400">The two fields don’t match yet.</span>
          ) : null}
          <button
            type="submit"
            disabled={draftPassword.length < 12 || draftPassword !== draftConfirm}
            className="cursor-pointer self-start rounded-sm border border-border/60 px-3 py-2 text-xs tracking-wider transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            CREATE PASSWORD
          </button>
        </form>
      ) : null}

      {writable && !password ? (
        secureHere ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (draftPassword) void unlock(draftPassword)
            }}
          >
            <input
              type="password"
              value={draftPassword}
              onChange={(e) => setDraftPassword(e.target.value)}
              placeholder="settings password"
              autoComplete="current-password"
              className="flex-1 rounded-sm border border-border/60 bg-card px-3 py-2 font-mono text-xs placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={!draftPassword}
              className="cursor-pointer rounded-sm border border-border/60 px-3 py-2 text-xs tracking-wider transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent disabled:opacity-40"
            >
              UNLOCK
            </button>
          </form>
        ) : (
          <p className="text-xs leading-relaxed text-amber-400">
            This origin is not a secure context — unlock from localhost or an HTTPS URL so the
            password never travels in the clear.
          </p>
        )
      ) : null}
      {unlockError ? <p className="text-xs text-red-400">{unlockError}</p> : null}
      {password ? (
        <p className="text-[10px] tracking-wider text-emerald-400">
          UNLOCKED · edits write .env.local on the server
        </p>
      ) : null}

      <div className="flex flex-col gap-2">{rows.primary.map((s) => renderRow(s))}</div>

      {rows.more.length > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="cursor-pointer self-start rounded-sm border border-border/60 px-2 py-1 text-[10px] tracking-widest text-muted-foreground transition-colors hover:border-accent hover:bg-accent/10 hover:text-accent"
        >
          {showAll ? 'HIDE' : `SHOW ALL (${rows.more.length} more)`}
        </button>
      ) : null}
      {showAll ? (
        <div className="flex flex-col gap-2">
          {rows.more.map((s) => renderRow(s))}
          <h4 className="mt-2 text-[10px] tracking-widest text-muted-foreground/60">
            DEPLOY (READ-ONLY)
          </h4>
          {rows.deploy.map((s) => renderRow(s, true))}
        </div>
      ) : null}
    </div>
  )
}
