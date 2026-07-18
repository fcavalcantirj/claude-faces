'use client'

// Whisper model download + caching UX (browser).
//
// Thin presentational layer over the headlessly-tested state machine in
// lib/stt/model-status.ts. On first browser-STT use it offers a DELIBERATE
// "download model" affordance (with the ~150 MB estimate), streams the download
// progress bar, and — once loaded — shows "ready, offline-capable" with the
// active backend (WebGPU/WASM). A cancel/skip control terminates the worker and
// routes STT to the hosted fallback. On reload the Cache-Storage probe surfaces
// the model as cached so it is not re-downloaded.
//
// The heavy logic lives in the controller; this file only renders it and wires
// the real Whisper worker. All browser primitives stay behind the injected
// controller so the logic is fully unit-tested without a Worker.

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  createModelStatusController,
  estimateModelSizeMb,
  statusTextFor,
  type ModelStatusController,
  type WhisperWorkerLike,
} from '@/lib/stt/model-status'
import { DEFAULT_WHISPER_MODEL } from '@/lib/stt/whisper-engine'

/** Spawn the real Whisper worker (client-only; never runs during SSR/tests). */
function spawnWhisperWorker(): WhisperWorkerLike {
  return new Worker(new URL('../lib/stt/whisper-worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WhisperWorkerLike
}

/**
 * Subscribe to a model-status controller and expose its state + actions.
 * Pass a controller (e.g. shared with the STT layer) or let the hook build one
 * that spawns the real Whisper worker.
 */
export function useSttModelStatus(
  controllerFactory: () => ModelStatusController = () =>
    createModelStatusController({ createWorker: spawnWhisperWorker }),
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
    download: () => controller.download(),
    cancel: () => controller.cancel(),
  }
}

export interface SttStatusProps {
  /** Inject a controller (default: one bound to the real Whisper worker). */
  controllerFactory?: () => ModelStatusController
  className?: string
}

/**
 * Compact panel for the browser-Whisper download/cache state. Drops the
 * "download model" call-to-action, a live progress bar, cancel/skip-to-hosted,
 * and the ready/cached readout with backend + model.
 */
export function SttStatus({ controllerFactory, className }: SttStatusProps) {
  const factory =
    controllerFactory ??
    (() => createModelStatusController({ createWorker: spawnWhisperWorker }))
  const { state, download, cancel } = useSttModelStatus(factory)

  const sizeMb = estimateModelSizeMb(state.modelId)
  const modelShort = state.modelId.replace(/^.*\//, '')

  return (
    <section
      className={`flex flex-col gap-2 rounded-sm border border-border/60 bg-card/40 p-3 font-mono text-[10px] tracking-wider text-muted-foreground ${className ?? ''}`}
      aria-label="Browser speech-to-text model status"
    >
      <div className="flex items-center justify-between">
        <span className="text-foreground">BROWSER WHISPER</span>
        <span
          className={
            state.phase === 'ready'
              ? 'text-emerald-400'
              : state.phase === 'error'
                ? 'text-red-400'
                : 'text-muted-foreground/70'
          }
        >
          {statusTextFor(state)}
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
            {state.cached ? 'LOAD MODEL' : `DOWNLOAD (~${sizeMb} MB)`}
          </button>
        )}

        {/* During download: cancel and fall back to hosted STT. */}
        {state.phase === 'downloading' && (
          <button
            type="button"
            onClick={cancel}
            className="pointer-events-auto rounded-sm border border-border px-2 py-1 text-foreground hover:border-red-400 hover:text-red-400"
          >
            SKIP TO HOSTED
          </button>
        )}
      </div>
    </section>
  )
}

export { DEFAULT_WHISPER_MODEL }
