'use client'

// Kokoro (all-local TTS) model download + caching UX (browser).
//
// Thin presentational layer over the headlessly-tested state machine in
// lib/tts/kokoro.ts. When the user turns on the local Kokoro voice it offers a
// DELIBERATE "download voice" affordance (with the ~86 MB estimate), streams the
// download progress bar, and — once loaded — shows "ready, offline-capable" with
// the active backend (WebGPU/WASM). A skip control terminates the worker and
// routes voice-out to the Web Speech fallback. On reload the Cache-Storage probe
// surfaces the model as cached so it is not re-downloaded.
//
// Mirrors components/stt-status.tsx: the heavy logic lives in the controller;
// this file only renders it and wires the real Kokoro worker. All browser
// primitives stay behind the injected controller so the logic is fully
// unit-tested without a Worker.

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  createKokoroController,
  estimateKokoroSizeMb,
  kokoroStatusTextFor,
  spawnKokoroWorker,
  type KokoroController,
} from '@/lib/tts/kokoro'
import { DEFAULT_KOKORO_MODEL } from '@/lib/tts/kokoro-engine'

/**
 * Subscribe to a Kokoro controller and expose its state + actions. Pass a
 * controller (e.g. the one shared with the TTS router) or let the hook build one
 * that spawns the real Kokoro worker.
 */
export function useKokoroStatus(
  controllerFactory: () => KokoroController = () =>
    createKokoroController({ createWorker: spawnKokoroWorker }),
) {
  const controller = useMemo(controllerFactory, [])

  const state = useSyncExternalStore(
    (cb) => controller.subscribe(cb),
    () => controller.getState(),
    () => controller.getState(),
  )

  useEffect(() => {
    void controller.init()
    return () => controller.destroy()
  }, [controller])

  return {
    state,
    download: () => controller.load(),
    cancel: () => controller.cancel(),
  }
}

export interface KokoroStatusProps {
  /** Inject a controller (default: one bound to the real Kokoro worker). */
  controllerFactory?: () => KokoroController
  className?: string
}

/**
 * Compact panel for the local Kokoro voice download/cache state. Drops a
 * "download voice" call-to-action, a live progress bar, skip-to-Web-Speech, and
 * the ready/cached readout with backend + model.
 */
export function KokoroStatus({ controllerFactory, className }: KokoroStatusProps) {
  const factory =
    controllerFactory ??
    (() => createKokoroController({ createWorker: spawnKokoroWorker }))
  const { state, download, cancel } = useKokoroStatus(factory)

  const sizeMb = estimateKokoroSizeMb(state.modelId)
  const modelShort = state.modelId.replace(/^.*\//, '')

  return (
    <section
      className={`flex flex-col gap-2 rounded-sm border border-border/60 bg-card/40 p-3 font-mono text-[10px] tracking-wider text-muted-foreground ${className ?? ''}`}
      aria-label="Local Kokoro voice model status"
    >
      <div className="flex items-center justify-between">
        <span className="text-foreground">LOCAL VOICE · KOKORO</span>
        <span
          className={
            state.phase === 'ready'
              ? 'text-emerald-400'
              : state.phase === 'error'
                ? 'text-red-400'
                : 'text-muted-foreground/70'
          }
        >
          {kokoroStatusTextFor(state)}
        </span>
      </div>

      {/* Progress bar while downloading. */}
      {state.phase === 'downloading' && (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-border/40"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.progress}
        >
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${state.progress}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground/60">
          {modelShort}
          {state.backend ? ` · ${state.backend.toUpperCase()}` : ''}
          {state.cached ? ' · CACHED' : ''}
        </span>

        {/* First-use: deliberate, explained download. */}
        {(state.phase === 'unloaded' ||
          state.phase === 'error' ||
          state.phase === 'canceled') && (
          <button
            type="button"
            onClick={download}
            className="pointer-events-auto rounded-sm border border-border px-2 py-1 text-foreground hover:border-accent hover:text-accent"
          >
            {state.cached ? 'LOAD VOICE' : `DOWNLOAD (~${sizeMb} MB)`}
          </button>
        )}

        {/* During download: skip and fall back to Web Speech. */}
        {state.phase === 'downloading' && (
          <button
            type="button"
            onClick={cancel}
            className="pointer-events-auto rounded-sm border border-border px-2 py-1 text-foreground hover:border-red-400 hover:text-red-400"
          >
            SKIP TO WEB SPEECH
          </button>
        )}
      </div>
    </section>
  )
}

export { DEFAULT_KOKORO_MODEL }
