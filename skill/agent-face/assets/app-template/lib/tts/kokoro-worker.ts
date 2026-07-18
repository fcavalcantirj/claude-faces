// Web Worker entry for all-local Kokoro-82M text-to-speech.
//
// The heavy model load + synthesis run OFF the main thread so the 60fps particle
// face never janks while a reply is voiced. This file is a THIN message shim:
// all real work lives in the headlessly-testable `KokoroEngine` (see
// ./kokoro-engine). The message protocol + the `createKokoroWorkerBridge`
// factory are exported so the TTS layer (which spawns the worker) and unit tests
// can share the exact contract without a real Worker.
//
// The worker is spawned by lib/tts/kokoro.ts with:
//   new Worker(new URL("./kokoro-worker.ts", import.meta.url), { type: "module" })

import {
  KokoroEngine,
  KokoroError,
  type KokoroBackend,
  type KokoroProgress,
} from "./kokoro-engine";

// --- Message protocol -------------------------------------------------------

/** Main thread → worker. */
export type KokoroRequest =
  | { type: "load"; modelId?: string }
  | {
      type: "synthesize";
      id: string;
      text: string;
      voice?: string;
      speed?: number;
    };

/** Worker → main thread. */
export type KokoroResponse =
  | ({ type: "progress" } & KokoroProgress)
  | { type: "ready"; backend: KokoroBackend; modelId: string }
  | {
      type: "audio";
      id: string;
      /** WAV audio bytes — played through an <audio> element + FFT analyser. */
      blob: Blob;
      backend: KokoroBackend;
      durationMs: number;
    }
  | { type: "error"; id?: string; message: string; fallbackToWebSpeech: boolean };

/** How the bridge posts messages back (real: self.postMessage). */
export type PostKokoroMessage = (msg: KokoroResponse) => void;

export interface KokoroWorkerBridge {
  /** Handle one inbound {@link KokoroRequest}. Never throws. */
  onMessage(msg: KokoroRequest): Promise<void>;
}

/**
 * Wire a {@link KokoroEngine} to the message protocol. Returned `onMessage`
 * translates each request into engine calls and posts progress/ready/audio/
 * error responses. All failures are caught and surfaced as an `error` response
 * (with `fallbackToWebSpeech`) rather than crashing the worker.
 */
export function createKokoroWorkerBridge(
  engine: KokoroEngine,
  post: PostKokoroMessage,
): KokoroWorkerBridge {
  async function handleLoad(modelId?: string): Promise<void> {
    try {
      const backend = await engine.load(
        (p) => post({ type: "progress", ...p }),
        modelId,
      );
      post({ type: "ready", backend, modelId: engine.modelId });
    } catch (err) {
      post({
        type: "error",
        message: errorMessage(err),
        fallbackToWebSpeech: fallbackFlag(err),
      });
    }
  }

  async function handleSynthesize(
    msg: Extract<KokoroRequest, { type: "synthesize" }>,
  ): Promise<void> {
    try {
      const result = await engine.synthesize(msg.text, {
        voice: msg.voice,
        speed: msg.speed,
      });
      post({
        type: "audio",
        id: msg.id,
        blob: result.blob,
        backend: result.backend,
        durationMs: result.durationMs,
      });
    } catch (err) {
      post({
        type: "error",
        id: msg.id,
        message: errorMessage(err),
        fallbackToWebSpeech: fallbackFlag(err),
      });
    }
  }

  return {
    async onMessage(msg: KokoroRequest): Promise<void> {
      switch (msg?.type) {
        case "load":
          return handleLoad(msg.modelId);
        case "synthesize":
          return handleSynthesize(msg);
        default:
          post({
            type: "error",
            message: `Unknown request: ${(msg as { type?: string })?.type}`,
            fallbackToWebSpeech: true,
          });
      }
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** An OOM/load failure signals Web Speech fallback; a bad-request does not. */
function fallbackFlag(err: unknown): boolean {
  if (err instanceof KokoroError) return err.fallbackToWebSpeech;
  return true;
}

// --- Dedicated-worker wiring ------------------------------------------------
//
// Only runs inside a real DedicatedWorkerGlobalScope (guarded by `importScripts`,
// which exists on worker globals but NOT on the jsdom/window global), so importing
// this module in tests or on the main thread is a no-op.

const workerScope = globalThis as unknown as {
  importScripts?: unknown;
  postMessage?: PostKokoroMessage;
  onmessage?: ((ev: MessageEvent<KokoroRequest>) => void) | null;
};

if (typeof workerScope.importScripts === "function" && workerScope.postMessage) {
  const engine = new KokoroEngine();
  const bridge = createKokoroWorkerBridge(engine, (msg) =>
    workerScope.postMessage!(msg),
  );
  workerScope.onmessage = (ev: MessageEvent<KokoroRequest>) => {
    void bridge.onMessage(ev.data);
  };
}
