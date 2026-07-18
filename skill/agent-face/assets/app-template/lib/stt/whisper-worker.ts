// Web Worker entry for in-browser Whisper transcription.
//
// The heavy model load + inference run OFF the main thread so the 60fps particle
// face never janks. This file is a THIN message shim: all real work lives in the
// headlessly-testable `WhisperEngine` (see ./whisper-engine). The message
// protocol + the `createWhisperWorkerBridge` factory are exported so the STT
// layer (which spawns the worker) and unit tests can share the exact contract
// without a real Worker.
//
// The worker is spawned by the STT auto-selection layer with:
//   new Worker(new URL("./whisper-worker.ts", import.meta.url), { type: "module" })

import {
  WhisperEngine,
  WhisperError,
  type WhisperBackend,
  type WhisperInput,
  type WhisperProgress,
} from "./whisper-engine";

// --- Message protocol -------------------------------------------------------

/** Main thread → worker. */
export type WhisperRequest =
  | { type: "load"; modelId?: string }
  | {
      type: "transcribe";
      id: string;
      /** Pre-decoded 16 kHz mono PCM (preferred — decode on the main thread). */
      audio?: Float32Array;
      /** Or a raw clip Blob to decode inside the worker. */
      blob?: Blob;
      language?: string;
    };

/** Worker → main thread. */
export type WhisperResponse =
  | ({ type: "progress" } & WhisperProgress)
  | { type: "ready"; backend: WhisperBackend; modelId: string }
  | {
      type: "result";
      id: string;
      text: string;
      backend: WhisperBackend;
      durationMs: number;
    }
  | { type: "error"; id?: string; message: string; fallbackToHosted: boolean };

/** How the bridge posts messages back (real: self.postMessage). */
export type PostMessage = (msg: WhisperResponse) => void;

export interface WhisperWorkerBridge {
  /** Handle one inbound {@link WhisperRequest}. Never throws. */
  onMessage(msg: WhisperRequest): Promise<void>;
}

/**
 * Wire a {@link WhisperEngine} to the message protocol. Returned `onMessage`
 * translates each request into engine calls and posts progress/ready/result/
 * error responses. All failures are caught and surfaced as an `error` response
 * (with `fallbackToHosted`) rather than crashing the worker.
 */
export function createWhisperWorkerBridge(
  engine: WhisperEngine,
  post: PostMessage,
): WhisperWorkerBridge {
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
        fallbackToHosted: fallbackFlag(err),
      });
    }
  }

  async function handleTranscribe(
    msg: Extract<WhisperRequest, { type: "transcribe" }>,
  ): Promise<void> {
    try {
      const input: WhisperInput | null =
        msg.audio instanceof Float32Array
          ? msg.audio
          : msg.blob
            ? { blob: msg.blob }
            : null;
      if (!input) {
        throw new WhisperError("transcribe request had no audio or blob", false);
      }
      const result = await engine.transcribe(input, {
        language: msg.language,
      });
      post({
        type: "result",
        id: msg.id,
        text: result.text,
        backend: result.backend,
        durationMs: result.durationMs,
      });
    } catch (err) {
      post({
        type: "error",
        id: msg.id,
        message: errorMessage(err),
        fallbackToHosted: fallbackFlag(err),
      });
    }
  }

  return {
    async onMessage(msg: WhisperRequest): Promise<void> {
      switch (msg?.type) {
        case "load":
          return handleLoad(msg.modelId);
        case "transcribe":
          return handleTranscribe(msg);
        default:
          post({
            type: "error",
            message: `Unknown request: ${(msg as { type?: string })?.type}`,
            fallbackToHosted: true,
          });
      }
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** An OOM/load failure signals hosted fallback; a bad-request does not. */
function fallbackFlag(err: unknown): boolean {
  if (err instanceof WhisperError) return err.fallbackToHosted;
  return true;
}

// --- Dedicated-worker wiring ------------------------------------------------
//
// Only runs inside a real DedicatedWorkerGlobalScope (guarded by `importScripts`,
// which exists on worker globals but NOT on the jsdom/window global), so importing
// this module in tests or on the main thread is a no-op.

const workerScope = globalThis as unknown as {
  importScripts?: unknown;
  postMessage?: PostMessage;
  onmessage?: ((ev: MessageEvent<WhisperRequest>) => void) | null;
};

if (typeof workerScope.importScripts === "function" && workerScope.postMessage) {
  const engine = new WhisperEngine();
  const bridge = createWhisperWorkerBridge(engine, (msg) =>
    workerScope.postMessage!(msg),
  );
  workerScope.onmessage = (ev: MessageEvent<WhisperRequest>) => {
    void bridge.onMessage(ev.data);
  };
}
