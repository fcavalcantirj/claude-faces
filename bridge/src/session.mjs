// The WARM session state machine: ONE long-lived streaming-input query()
// carries successive turns — the per-turn CLI subprocess spawn (~1.1-2.0s,
// measured 2026-07-20) was the single largest fixed cost of every turn.
// OpenAI clients replay the full history every request; the SDK session
// persists on the CLI's disk — so the bridge sends ONLY the latest user
// message: into the OPEN query while it lives, via `resume` when rebuilding.
//
// Failure discipline (generalizes the old per-turn one, mirrors hermes-agent):
//
//   • no assistant turns in the history  → conversation RESET: close the warm
//     query, open fresh with NO resume — never bleed old context
//   • compatible follow-up turn          → push into the open query (warm)
//   • systemText changed                 → close + reopen with resume
//   • a WARM or RESUMED attempt throws   → close, ONE cold retry (resume if
//     an id is stored, else fresh + digest); a stale resume retires the id
//   • a FRESH cold attempt throws        → no retry; surface the error
//   • abort / timeout                    → close, no in-turn retry; the NEXT
//     turn rebuilds cold with resume (restart-recovery)
//
// Teardown discipline: the real SDK owns a Claude Code CLI subprocess that
// LEAKS if not closed. The warm handle is assigned BEFORE any await (the
// half-connected lesson), and every FAILURE path reaches closeWarm() — a
// clean turn deliberately leaves the query open; server shutdown calls
// session.close(). closeWarm() must NOT await the generator: an async
// generator blocked on a pending await settles .return() only after that
// await resolves, which for a hung turn is never. The AbortController is the
// authoritative kill; interrupt()/close()/return() are fire-and-forget
// courtesy. Only a clean success at a result boundary lets a handle survive
// a turn, so a half-consumed stream can never leak into the next turn.

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

/** @typedef {{ type: "user", message: { role: "user", content: string }, parent_tool_use_id: null }} BridgeUserMessage */

/** The minimal valid SDKUserMessage for the streaming-input arm.
 * @param {string} text
 * @returns {BridgeUserMessage} */
function userMessage(text) {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

/** A push-queue AsyncIterable: the prompt handed to query() at open. The SDK
 * pulls; runTurn pushes one user message per turn; end() releases a pending
 * pull with {done:true} so a closed handle's consumer always terminates. */
function createInputQueue() {
  const buffered = [];
  let pendingResolve = null;
  let ended = false;
  const push = (msg) => {
    if (ended) return;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ value: msg, done: false });
    } else {
      buffered.push(msg);
    }
  };
  const end = () => {
    ended = true;
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve({ value: undefined, done: true });
    }
  };
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buffered.length > 0) return Promise.resolve({ value: buffered.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        },
        return() {
          ended = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return { push, end, iterable };
}

/**
 * @param {{
 *   queryFn: (args: { prompt: AsyncIterable<BridgeUserMessage>, options: Record<string, unknown> }) => AsyncGenerator<any, any, any>,
 *   model?: string | null,
 *   permissionMode?: string,
 *   cwd?: string | null,
 *   warm?: boolean,
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
  warm = true,
  initTimeoutMs = 60_000,
  turnTimeoutMs = 600_000,
  ackPhrases = DEFAULT_ACK_PHRASES,
  now = Date.now,
  onTiming = null,
}) {
  let storedSessionId = null;
  /** @type {{ q: any, queue: ReturnType<typeof createInputQueue>, openAc: AbortController, systemText: string } | null} */
  let warmHandle = null;
  let turnActive = false; // defensive; the server's turn lock is the primary serializer
  let closeRequested = false; // close() arrived MID-turn: the retry path must not respawn

  /** Open a query and ride the first turn's message on the open itself (the
   * message is buffered before the SDK ever pulls — spawn + turn 1 are one
   * round trip). The handle is assigned before any await. */
  function openWarm({ systemText, resumeId, firstText }) {
    const openAc = new AbortController();
    const options = {
      includePartialMessages: true,
      permissionMode,
      systemPrompt: systemText
        ? { type: "preset", preset: "claude_code", append: systemText }
        : { type: "preset", preset: "claude_code" },
      abortController: openAc,
    };
    if (model) options.model = model;
    if (cwd) options.cwd = cwd;
    if (resumeId) options.resume = resumeId;

    const queue = createInputQueue();
    queue.push(userMessage(firstText));
    const q = queryFn({ prompt: queue.iterable, options });
    warmHandle = { q, queue, openAc, systemText };
    return warmHandle;
  }

  /** Idempotent, never awaited: abort is the authoritative subprocess kill. */
  function closeWarm() {
    const handle = warmHandle;
    if (!handle) return;
    warmHandle = null;
    handle.openAc.abort();
    try {
      Promise.resolve(handle.q.interrupt?.()).catch(() => {});
    } catch {
      /* best-effort */
    }
    try {
      if (typeof handle.q.close === "function") handle.q.close();
      else Promise.resolve(handle.q.return?.()).catch(() => {});
    } catch {
      /* best-effort */
    }
    handle.queue.end();
  }

  /** Consume ONE turn's messages from the open query, breaking at the result
   * boundary. Between turns nobody reads — the generator stays suspended. */
  async function runTurnSlice({ handle, isOpenTurn, resumeId, t0, onDelta, signal, turnState }) {
    const q = handle.q;
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
        warm: !isOpenTurn,
        initMs: initMs ?? undefined,
        firstDeltaMs: firstDeltaMs ?? undefined,
        totalMs: now() - t0,
        ackSynthetic: ackFirst,
        ok,
      });
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
        // Until the turn's first event the ceiling is the init timeout: on an
        // opening turn it bounds spawn+handshake; on a warm turn it bounds a
        // wedged idle process (no spawn, but silence must still fail in time).
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
            // initMs is the spawn+handshake cost — only an OPENING turn has
            // one. (A warm turn's result also carries a session event;
            // measuring it here would report initMs ≈ totalMs.)
            if (isOpenTurn && initMs === null) initMs = now() - t0;
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
      throw err;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }

    if (!resultEvent) {
      // Also the stale-warm-handle shape: the CLI exited between turns and the
      // generator finished — runTurn's retry policy rebuilds cold with resume.
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

    /** Public teardown for server shutdown — reaps the warm subprocess. The
     * stored resume id survives, so a later turn can still rebuild. When a
     * turn is in flight, its retry is latched off: a respawn here would be
     * orphaned by the exiting process and keep generating headless. */
    close() {
      if (turnActive) closeRequested = true;
      closeWarm();
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
      if (turnActive) throw new Error("A turn is already in flight on this session.");
      turnActive = true;
      closeRequested = false; // a close() BETWEEN turns doesn't poison this one
      try {
        if (!hasAssistantTurns) {
          // A history with no assistant turns is a NEW conversation: whatever
          // context the warm query holds is over. Close it and forget the id.
          storedSessionId = null;
          closeWarm();
        } else if (warmHandle && warmHandle.systemText !== systemText) {
          // The system prompt is fixed when a query opens; a persona change
          // recycles the process while `resume` carries the context across.
          closeWarm();
        }

        const turnState = { ackSent: false };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const reused = attempt === 0 && warmHandle !== null;
          const resumeId = !reused && hasAssistantTurns ? storedSessionId : null;
          const needsDigest = !reused && hasAssistantTurns && !resumeId;
          const digest = needsDigest ? buildContinuityDigest(messages) : "";
          const promptText = digest ? `${digest}\n\n${latestUserText}` : latestUserText;

          const t0 = now();
          let handle;
          if (reused) {
            handle = warmHandle;
            handle.queue.push(userMessage(promptText));
          } else {
            handle = openWarm({ systemText, resumeId, firstText: promptText });
          }
          try {
            const out = await runTurnSlice({
              handle,
              isOpenTurn: !reused,
              resumeId,
              t0,
              onDelta,
              signal,
              turnState,
            });
            // warm:false is the escape hatch (CLAUDE_BRIDGE_WARM=0): behave
            // exactly like the old bridge — one process per turn, resume next.
            if (!warm) closeWarm();
            return out;
          } catch (err) {
            closeWarm();
            const retryable =
              attempt === 0 &&
              !closeRequested &&
              (reused || Boolean(resumeId)) &&
              !(err instanceof BridgeAbortError) &&
              !(err instanceof BridgeTimeoutError);
            if (!retryable) throw err;
            // A dead RESUMED attempt means the id is stale: retire it so the
            // retry falls back to fresh + digest. A dead WARM attempt keeps
            // the id — the process's context is on disk, resume it.
            if (resumeId) storedSessionId = null;
          }
        }
        throw new Error("unreachable: both session attempts exhausted");
      } finally {
        turnActive = false;
      }
    },
  };
}
