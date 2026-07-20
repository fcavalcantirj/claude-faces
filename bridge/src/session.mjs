// The session state machine: one-shot query() per HTTP request, resumed via
// the session id captured from the SDK's init message. OpenAI clients replay
// the full history every request; the SDK session persists on the CLI's disk —
// so the bridge sends ONLY the latest user message and lets `resume` carry the
// context. Failure discipline (mirrors hermes-agent):
//
//   • no assistant turns in the history  → new conversation → fresh session
//   • assistant turns + stored id        → resume
//   • assistant turns + NO stored id     → fresh + continuity digest
//   • a RESUMED attempt that throws      → retire the id, ONE fresh retry + digest
//   • a FRESH attempt that throws        → no retry; surface the error
//
// Teardown discipline: the real SDK owns a Claude Code CLI subprocess that
// LEAKS if not disposed. The query handle is assigned BEFORE any await (the
// half-connected lesson), and every exit path — success, thrown error, client
// abort, timeout — reaches the same dispose(). dispose() must NOT await the
// generator: an async generator blocked on a pending await settles .return()
// only after that await resolves, which for a hung turn is never. The
// AbortController is the authoritative kill; interrupt()/return() are
// fire-and-forget courtesy.

import { buildContinuityDigest } from "./digest.mjs";
import { projectMessage } from "./projector.mjs";

export class BridgeAbortError extends Error {
  constructor() {
    super("The request was aborted by the client.");
    this.name = "BridgeAbortError";
  }
}

export class BridgeTimeoutError extends Error {
  constructor(ms) {
    super(`The agent turn timed out after ${ms}ms; the query was interrupted.`);
    this.name = "BridgeTimeoutError";
  }
}

/** Spoken when the agent starts tool work without having said anything yet —
 * a tool-using turn can be silent for many seconds, and a talking face that
 * goes mute reads as broken (live finding, 2026-07-19). */
const DEFAULT_ACK_PHRASES = [
  "Got it — on it.",
  "On it — one moment.",
  "Okay, working on that now.",
  "Give me a second — doing it now.",
];

/**
 * @param {{
 *   queryFn: (args: { prompt: string, options: Record<string, unknown> }) => AsyncGenerator<any, any, any>,
 *   model?: string | null,
 *   permissionMode?: string,
 *   cwd?: string | null,
 *   initTimeoutMs?: number,
 *   turnTimeoutMs?: number,
 *   ackPhrases?: string[],
 *   now?: () => number,
 *   onTiming?: (rec: Record<string, unknown>) => void,
 * }} config
 */
export function createSession({
  queryFn,
  model = null,
  permissionMode = "acceptEdits",
  cwd = null,
  initTimeoutMs = 60_000,
  turnTimeoutMs = 600_000,
  ackPhrases = DEFAULT_ACK_PHRASES,
  now = Date.now,
  onTiming = null,
}) {
  let storedSessionId = null;

  async function runAttempt({ prompt, systemText, resumeId, onDelta, signal, turnState }) {
    const abortController = new AbortController();
    const options = {
      includePartialMessages: true,
      permissionMode,
      systemPrompt: systemText
        ? { type: "preset", preset: "claude_code", append: systemText }
        : { type: "preset", preset: "claude_code" },
      abortController,
    };
    if (model) options.model = model;
    if (cwd) options.cwd = cwd;
    if (resumeId) options.resume = resumeId;

    // Attempt-local timing: t0 sits BEFORE the query() call so the mark set
    // captures the whole cost this bridge adds — CLI subprocess spawn + resume
    // + model TTFT — per attempt. Emitted once via onTiming (ok=false when the
    // attempt threw); firstDelta may be the synthetic ack (flagged).
    const t0 = now();
    let initMs = null;
    let firstDeltaMs = null;
    let ackFirst = false;
    let timingSent = false;
    const emitDelta = (text, synthetic = false) => {
      if (firstDeltaMs === null) {
        firstDeltaMs = now() - t0;
        ackFirst = synthetic;
      }
      onDelta?.(text);
    };
    const emitTiming = (ok) => {
      if (timingSent || !onTiming) return;
      timingSent = true;
      onTiming({
        v: 1,
        kind: "bridge",
        resumed: Boolean(resumeId),
        initMs: initMs ?? undefined,
        firstDeltaMs: firstDeltaMs ?? undefined,
        totalMs: now() - t0,
        ackSynthetic: ackFirst,
        ok,
      });
    };

    // Handle BEFORE any await: a failure during startup must still leave
    // something dispose() can reap.
    const q = queryFn({ prompt, options });
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      abortController.abort();
      try {
        Promise.resolve(q.interrupt?.()).catch(() => {});
      } catch {
        /* best-effort */
      }
      try {
        Promise.resolve(q.return?.()).catch(() => {});
      } catch {
        /* best-effort */
      }
    };

    let onAbort = null;
    const aborted = new Promise((_, reject) => {
      if (!signal) return;
      if (signal.aborted) {
        reject(new BridgeAbortError());
        return;
      }
      onAbort = () => reject(new BridgeAbortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {}); // may never be consumed by the race

    let sawDelta = false;
    let lastAssistantText = null;
    let resultEvent = null;
    const startedAt = now();

    try {
      let gotFirst = false;
      for (;;) {
        const ceiling = gotFirst ? turnTimeoutMs : Math.min(initTimeoutMs, turnTimeoutMs);
        const budget = ceiling - (now() - startedAt);
        if (budget <= 0) throw new BridgeTimeoutError(ceiling);
        let timer = null;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new BridgeTimeoutError(ceiling)), budget);
        });
        const next = q.next();
        next.catch(() => {}); // it may lose the race; never let it go unhandled
        let step;
        try {
          step = await Promise.race([next, timeout, aborted]);
        } finally {
          clearTimeout(timer);
        }
        if (step.done) break;
        gotFirst = true;
        for (const ev of projectMessage(step.value)) {
          if (ev.type === "session") {
            storedSessionId = ev.sessionId;
            if (initMs === null) initMs = now() - t0;
          } else if (ev.type === "delta") {
            sawDelta = true;
            emitDelta(ev.text);
          } else if (ev.type === "tool_activity") {
            // Silent tool work ahead: speak ONE short acknowledgment — unless
            // the agent already said something itself (turn-scoped, so a
            // digest retry can never double-ack).
            if (!sawDelta && turnState && !turnState.ackSent) {
              turnState.ackSent = true;
              const phrase = ackPhrases[Math.floor(Math.random() * ackPhrases.length)];
              emitDelta(`${phrase} `, true);
            }
          } else if (ev.type === "assistant_text") lastAssistantText = ev.text;
          else if (ev.type === "result") resultEvent = ev;
        }
        if (resultEvent) break;
      }
    } catch (err) {
      emitTiming(false);
      dispose();
      throw err;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    dispose();

    if (!resultEvent) {
      emitTiming(false);
      throw new Error("The SDK stream ended without a result message.");
    }
    const text = resultEvent.text ?? lastAssistantText ?? "";
    // Streaming can be unavailable (or filtered); the reply still reaches the
    // client as one delta rather than silently vanishing.
    if (!sawDelta && text) emitDelta(text);
    emitTiming(true);
    return {
      text,
      usage: resultEvent.usage,
      finishReason: resultEvent.finishReason,
      isError: resultEvent.isError,
    };
  }

  return {
    get sessionId() {
      return storedSessionId;
    },

    /**
     * @param {{
     *   latestUserText: string,
     *   systemText?: string,
     *   hasAssistantTurns?: boolean,
     *   messages?: Array<{ role: string, content: unknown }>,
     *   onDelta?: (text: string) => void,
     *   signal?: AbortSignal,
     * }} turn
     */
    async runTurn({ latestUserText, systemText = "", hasAssistantTurns = false, messages = [], onDelta, signal }) {
      // A history with no assistant turns is a NEW conversation: whatever
      // session we were resuming is over.
      if (!hasAssistantTurns) storedSessionId = null;

      const turnState = { ackSent: false };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const resumeId = attempt === 0 && hasAssistantTurns ? storedSessionId : null;
        const needsDigest = hasAssistantTurns && !resumeId;
        const digest = needsDigest ? buildContinuityDigest(messages) : "";
        const prompt = digest ? `${digest}\n\n${latestUserText}` : latestUserText;
        try {
          return await runAttempt({ prompt, systemText, resumeId, onDelta, signal, turnState });
        } catch (err) {
          const retryable =
            Boolean(resumeId) &&
            attempt === 0 &&
            !(err instanceof BridgeAbortError) &&
            !(err instanceof BridgeTimeoutError);
          if (!retryable) throw err;
          // Stale resume hard-fails: retire the id, retry ONCE fresh + digest.
          storedSessionId = null;
        }
      }
      throw new Error("unreachable: both session attempts exhausted");
    },
  };
}
