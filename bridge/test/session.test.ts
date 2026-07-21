// @vitest-environment node
//
// The WARM session state machine: ONE long-lived streaming-input query carries
// successive turns (the per-turn subprocess spawn was ~1.1-2.0s of every turn's
// latency). The failure discipline generalizes the old per-turn one:
//   • fresh conversation (no assistant turns) → close the warm query, open
//     fresh with NO resume — a reset must never bleed old context
//   • compatible follow-up turn → push into the open query (warm reuse)
//   • systemText changed → close + reopen with resume (persona swap)
//   • a WARM or RESUMED attempt that throws → close, retry ONCE cold
//     (resume if an id is stored, else fresh + digest)
//   • a FRESH cold attempt that throws → no retry, surface the error
//   • abort / timeout → close the warm query, no in-turn retry; the NEXT
//     turn rebuilds cold with resume (restart-recovery)
// And the teardown discipline: every failure path reaches closeWarm(), because
// the real SDK owns a Claude Code CLI subprocess that leaks otherwise. A clean
// turn leaves the query OPEN — that is the whole point.
// warm:false degrades to the old per-turn behavior (query + resume per turn).

import { describe, it, expect } from "vitest";
import { createSession } from "../src/session.mjs";

type Msg = Record<string, unknown>;
interface Script {
  messages?: Msg[];
  throwAfter?: number; // throw after yielding this many messages
  hang?: boolean; // never finish after yielding all messages
  endSession?: boolean; // generator returns after this turn (CLI exited)
}

const INIT = (id: string): Msg => ({ type: "system", subtype: "init", session_id: id });
const DELTA = (text: string): Msg => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const RESULT = (id: string, text: string): Msg => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  session_id: id,
  usage: { input_tokens: 4, output_tokens: 6 },
});
/** A result the projector emits NO session event for (no session_id). */
const RESULT_NO_ID = (text: string): Msg => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  usage: { input_tokens: 4, output_tokens: 6 },
});

const OK_TURN = (id = "sess-A", text = "hello"): Script => ({
  messages: [INIT(id), DELTA("hel"), DELTA("lo"), RESULT(id, text)],
});
/** A WARM turn's stream: no system/init — only the result carries the id. */
const WARM_TURN = (id: string, text: string): Script => ({
  messages: [DELTA(text.slice(0, 3)), DELTA(text.slice(3)), RESULT(id, text)],
});

/**
 * Scripted streaming-input queryFn. The prompt is an AsyncIterable of
 * SDKUserMessages; each pulled message plays the next script from a GLOBAL
 * turn counter (turn N runs scripts[N], last script repeats) — so script
 * numbering follows TURNS, not query calls, and warm reuse is observable as
 * calls.length < turns.
 */
function scripted(scripts: Script[]) {
  const calls: Array<{ prompts: string[]; options: Record<string, any> }> = [];
  const interrupts: number[] = [];
  const returns: number[] = [];
  const closes: number[] = [];
  const streamInputs: number[] = [];
  let turn = 0;
  const queryFn = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<{ message: { content: string } }>;
    options: Record<string, any>;
  }) => {
    const idx = calls.length;
    const rec = { prompts: [] as string[], options };
    calls.push(rec);
    let closed = false;
    let hangRelease: (() => void) | null = null;
    const gen = (async function* () {
      const inputs = prompt[Symbol.asyncIterator]();
      for (;;) {
        const step = await inputs.next();
        if (step.done || closed) return;
        rec.prompts.push(String(step.value.message.content));
        const script = scripts[Math.min(turn, scripts.length - 1)];
        turn += 1;
        let yielded = 0;
        for (const m of script.messages ?? []) {
          if (script.throwAfter !== undefined && yielded >= script.throwAfter) break;
          yield m;
          yielded += 1;
        }
        if (script.throwAfter !== undefined) throw new Error("SDK query failed (scripted)");
        if (script.hang && !closed) {
          await new Promise<void>((resolve) => {
            hangRelease = resolve;
          });
        }
        if (script.hang && !closed) return; // released without close: just end
        if (closed) return;
        if (script.endSession) return;
      }
    })();
    (gen as any).interrupt = async () => {
      interrupts.push(idx);
    };
    // Model the real SDK: close() terminates the subprocess, so the message
    // stream ENDS — a generator hung mid-turn finishes instead of hanging.
    (gen as any).close = () => {
      closes.push(idx);
      closed = true;
      hangRelease?.();
    };
    (gen as any).streamInput = async () => {
      streamInputs.push(idx);
    };
    const origReturn = gen.return.bind(gen);
    (gen as any).return = async (v?: unknown) => {
      returns.push(idx);
      return origReturn(v as never);
    };
    return gen;
  };
  return { queryFn, calls, interrupts, returns, closes, streamInputs };
}

const baseTurn = {
  latestUserText: "what is up?",
  systemText: "be brief",
  hasAssistantTurns: false,
  messages: [{ role: "user", content: "what is up?" }],
};

const followUp = (text: string) => ({
  ...baseTurn,
  latestUserText: text,
  hasAssistantTurns: true,
  messages: [
    { role: "user", content: "what is up?" },
    { role: "assistant", content: "hello" },
    { role: "user", content: text },
  ],
});

describe("createSession.runTurn (warm)", () => {
  it("fresh conversation: no resume, preset system prompt, deltas forwarded, result returned", async () => {
    const { queryFn, calls } = scripted([OK_TURN()]);
    const s = createSession({ queryFn, model: "claude-sonnet-5", permissionMode: "acceptEdits" });
    const deltas: string[] = [];
    const out = await s.runTurn({ ...baseTurn, onDelta: (t: string) => deltas.push(t) });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompts).toEqual(["what is up?"]);
    expect(calls[0].options.resume).toBeUndefined();
    expect(calls[0].options.includePartialMessages).toBe(true);
    expect(calls[0].options.permissionMode).toBe("acceptEdits");
    expect(calls[0].options.model).toBe("claude-sonnet-5");
    expect(calls[0].options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "be brief",
    });
    expect(deltas).toEqual(["hel", "lo"]);
    expect(out).toMatchObject({ text: "hello", finishReason: "stop", isError: false });
    expect(out.usage).toEqual({ prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
    expect(s.sessionId).toBe("sess-A");
  });

  it("W1: successive turns REUSE the one open query — no new call, no resume, prompts accumulate", async () => {
    const { queryFn, calls, streamInputs } = scripted([
      OK_TURN("sess-A"),
      WARM_TURN("sess-B", "again"),
      WARM_TURN("sess-C", "more!"),
    ]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    await s.runTurn({ ...followUp("and now?"), onDelta: () => {} });
    const out = await s.runTurn({ ...followUp("and then?"), onDelta: () => {} });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompts).toEqual(["what is up?", "and now?", "and then?"]);
    expect(calls[0].options.resume).toBeUndefined();
    expect(out.text).toBe("more!");
    // The id stays fresh from each turn's result — ready for a rebuild.
    expect(s.sessionId).toBe("sess-C");
    // streamInput() is deliberately NOT the input path (prompt iterable is).
    expect(streamInputs).toEqual([]);
  });

  it("assistant turns but no stored id (bridge restarted) → fresh with continuity digest", async () => {
    const { queryFn, calls } = scripted([OK_TURN("sess-B")]);
    const s = createSession({ queryFn });
    await s.runTurn({
      ...baseTurn,
      latestUserText: "where were we?",
      hasAssistantTurns: true,
      messages: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "where were we?" },
      ],
      onDelta: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].options.resume).toBeUndefined();
    expect(calls[0].prompts[0]).toContain("Continuity digest");
    expect(calls[0].prompts[0]).toContain("earlier answer");
    expect(calls[0].prompts[0]).toMatch(/where were we\?$/);
  });

  it("W2: a NEW conversation CLOSES the warm query and opens fresh (no resume, no digest, no bleed)", async () => {
    const { queryFn, calls, closes } = scripted([OK_TURN("sess-A")]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, hasAssistantTurns: true, onDelta: () => {} });
    // The user hit "new conversation": history has no assistant turns again.
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    expect(closes).toContain(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBeUndefined();
    expect(calls[1].prompts).toEqual(["what is up?"]);
  });

  it("W3: a warm turn that fails closes the query and retries ONCE cold with resume", async () => {
    const { queryFn, calls, interrupts, closes } = scripted([
      OK_TURN("sess-A"), // turn 1 opens warm, stores the id
      { throwAfter: 0 }, // turn 2, warm reuse: the open query dies
      OK_TURN("sess-C", "recovered"), // turn 2, cold rebuild: succeeds
    ]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    const out = await s.runTurn({ ...followUp("continue please"), onDelta: () => {} });

    expect(calls).toHaveLength(2);
    expect(closes).toContain(0);
    expect(interrupts).toContain(0);
    // The dead process's context survives on the CLI's disk — resume it.
    expect(calls[1].options.resume).toBe("sess-A");
    expect(calls[1].prompts[0]).not.toContain("Continuity digest");
    expect(out.text).toBe("recovered");
    expect(s.sessionId).toBe("sess-C");
  });

  it("W3b: a warm failure with NO stored id rebuilds fresh + digest", async () => {
    const { queryFn, calls } = scripted([
      { messages: [DELTA("ok"), RESULT_NO_ID("ok")] }, // turn 1: no id captured
      { throwAfter: 0 }, // turn 2, warm reuse: dies
      OK_TURN("sess-Z", "recovered"), // turn 2, cold rebuild
    ]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    const out = await s.runTurn({ ...followUp("continue please"), onDelta: () => {} });

    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBeUndefined();
    expect(calls[1].prompts[0]).toContain("Continuity digest");
    expect(out.text).toBe("recovered");
  });

  it("W6: a systemText change recycles the warm query WITH resume (persona swap keeps context)", async () => {
    const { queryFn, calls, closes } = scripted([OK_TURN("sess-A"), OK_TURN("sess-B", "anew")]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    await s.runTurn({ ...followUp("and now?"), systemText: "be verbose", onDelta: () => {} });

    expect(closes).toContain(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "be verbose",
    });
    expect(calls[1].options.resume).toBe("sess-A");
    expect(calls[1].prompts).toEqual(["and now?"]);
  });

  it("W8: a warm query whose generator ended between turns transparently rebuilds with resume", async () => {
    const { queryFn, calls } = scripted([
      { ...OK_TURN("sess-A"), endSession: true }, // CLI exits after turn 1
      OK_TURN("sess-B", "back"), // the rebuild
    ]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    const out = await s.runTurn({ ...followUp("and now?"), onDelta: () => {} });

    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe("sess-A");
    expect(out.text).toBe("back");
  });

  it("W10: session.close() closes the warm query; the next turn reopens cold with resume", async () => {
    const { queryFn, calls, closes } = scripted([OK_TURN("sess-A"), OK_TURN("sess-B", "back")]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    s.close();
    expect(closes).toContain(0);
    const out = await s.runTurn({ ...followUp("and now?"), onDelta: () => {} });
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe("sess-A");
    expect(out.text).toBe("back");
  });

  it("W12: session.close() during an in-flight turn fails the turn WITHOUT a respawn (shutdown latch)", async () => {
    // SIGTERM arrives mid-turn: shutdown calls session.close(). The dying
    // stream ends without a result — the retry path must NOT open a fresh
    // subprocess that would outlive (and be orphaned by) the exiting bridge.
    const { queryFn, calls, closes } = scripted([
      OK_TURN("sess-A"),
      { messages: [DELTA("par")], hang: true },
    ]);
    const s = createSession({ queryFn, turnTimeoutMs: 200, initTimeoutMs: 150 });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    const turn = s.runTurn({
      ...followUp("and now?"),
      onDelta: () => s.close(), // shutdown mid-stream
    });
    await expect(turn).rejects.toThrow(/without a result/i);
    expect(closes).toContain(0);
    expect(calls).toHaveLength(1); // no post-shutdown respawn
  });

  it("input queue serves an EAGER pump: a pending pull is resolved by push and released by close", async () => {
    // The real SDK's input pump pulls continuously — between turns it parks a
    // PENDING pull on the queue (the scripted fake pulls lockstep and never
    // does). This covers the resolve-pending-on-push and end-releases-pending
    // branches the real SDK exercises.
    const pulls: string[] = [];
    let sawDone = false;
    const queryFn = ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      const inbox: string[] = [];
      const wake: { fn: (() => void) | null } = { fn: null };
      void (async () => {
        for await (const msg of prompt) {
          inbox.push(String(msg.message.content));
          wake.fn?.();
        }
        sawDone = true; // end() released the parked pull
      })();
      const gen = (async function* () {
        for (;;) {
          while (inbox.length === 0)
            await new Promise<void>((resolve) => {
              wake.fn = resolve;
            });
          const text = inbox.shift()!;
          pulls.push(text);
          yield INIT("sess-E");
          yield DELTA("ok");
          yield RESULT("sess-E", `ok:${text}`);
        }
      })();
      (gen as any).interrupt = async () => {};
      (gen as any).close = () => {};
      return gen;
    };
    const s = createSession({ queryFn });
    const out1 = await s.runTurn({ ...baseTurn, onDelta: () => {} });
    const out2 = await s.runTurn({ ...followUp("and now?"), onDelta: () => {} });
    expect(pulls).toEqual(["what is up?", "and now?"]);
    expect(out1.text).toBe("ok:what is up?");
    expect(out2.text).toBe("ok:and now?"); // no cross-turn mixup under an eager pump
    s.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sawDone).toBe(true);
  });

  it("a FRESH attempt that fails does NOT retry", async () => {
    const { queryFn, calls } = scripted([{ throwAfter: 0 }]);
    const s = createSession({ queryFn });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/scripted/);
    expect(calls).toHaveLength(1);
  });

  it("tool work before any text → ONE synthetic spoken acknowledgment, then the answer", async () => {
    // Live finding (2026-07-19): a tool-using turn can be silent for many
    // seconds. When the agent starts tool work having said nothing, the bridge
    // itself speaks a short ack so the face is never mute while working.
    const TOOL_MSG = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t-1", name: "Write", input: {} }] },
    };
    const { queryFn } = scripted([
      { messages: [INIT("s"), TOOL_MSG, TOOL_MSG, RESULT("s", "file created")] },
    ]);
    const s = createSession({ queryFn, ackPhrases: ["ACK."] });
    const deltas: string[] = [];
    const out = await s.runTurn({ ...baseTurn, onDelta: (t: string) => deltas.push(t) });
    // Exactly one ack (not one per tool call), then the fallback answer text.
    expect(deltas).toEqual(["ACK. ", "file created"]);
    expect(out.text).toBe("file created"); // the ack never pollutes the result text
  });

  it("no synthetic ack when the agent already spoke before its tool work", async () => {
    const { queryFn } = scripted([
      {
        messages: [
          INIT("s"),
          DELTA("On it!"),
          {
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "t-1", name: "Write", input: {} }] },
          },
          RESULT("s", "done"),
        ],
      },
    ]);
    const s = createSession({ queryFn, ackPhrases: ["ACK."] });
    const deltas: string[] = [];
    await s.runTurn({ ...baseTurn, onDelta: (t: string) => deltas.push(t) });
    expect(deltas[0]).toBe("On it!");
    expect(deltas).not.toContain("ACK. ");
  });

  it("no stream deltas → the result text is delivered as one fallback delta", async () => {
    const { queryFn } = scripted([{ messages: [INIT("s"), RESULT("s", "full reply")] }]);
    const s = createSession({ queryFn });
    const deltas: string[] = [];
    const out = await s.runTurn({ ...baseTurn, onDelta: (t: string) => deltas.push(t) });
    expect(deltas).toEqual(["full reply"]);
    expect(out.text).toBe("full reply");
  });

  it("a stream that ends without a result message is an error", async () => {
    const { queryFn } = scripted([{ messages: [INIT("s"), DELTA("half")], endSession: true }]);
    const s = createSession({ queryFn });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/without a result/i);
  });

  it("W4: client abort interrupts + CLOSES the warm query; the next turn rebuilds with resume", async () => {
    const { queryFn, calls, interrupts, closes } = scripted([
      OK_TURN("sess-A"),
      { messages: [DELTA("par")], hang: true }, // turn 2, warm: hangs mid-stream
      OK_TURN("sess-D", "later"), // turn 3: the rebuild
    ]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });

    const ac = new AbortController();
    const turn = s.runTurn({
      ...followUp("and now?"),
      signal: ac.signal,
      onDelta: () => setTimeout(() => ac.abort(), 5),
    });
    await expect(turn).rejects.toThrow(/abort/i);
    expect(interrupts).toContain(0);
    expect(closes).toContain(0);

    const out = await s.runTurn({ ...followUp("still there?"), onDelta: () => {} });
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe("sess-A");
    expect(out.text).toBe("later");
  });

  it("W5: a warm turn timeout closes the query with NO in-turn retry", async () => {
    const { queryFn, calls, closes } = scripted([
      OK_TURN("sess-A"),
      { messages: [DELTA("x")], hang: true },
    ]);
    const s = createSession({ queryFn, turnTimeoutMs: 80, initTimeoutMs: 60 });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    await expect(s.runTurn({ ...followUp("and now?"), onDelta: () => {} })).rejects.toThrow(
      /timed out/i,
    );
    expect(closes).toContain(0);
    expect(calls).toHaveLength(1);
  });

  it("init timeout (no first message) interrupts and closes the query", async () => {
    const { queryFn, interrupts, closes } = scripted([{ messages: [], hang: true }]);
    const s = createSession({ queryFn, initTimeoutMs: 50, turnTimeoutMs: 5_000 });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/timed out/i);
    expect(interrupts).toContain(0);
    expect(closes).toContain(0);
  });

  it("an error thrown mid-stream still closes the query", async () => {
    const { queryFn, interrupts, closes } = scripted([
      { messages: [INIT("s"), DELTA("x")], throwAfter: 2 },
    ]);
    const s = createSession({ queryFn });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/scripted/);
    expect(interrupts).toContain(0);
    expect(closes).toContain(0);
  });
});

describe("createSession.runTurn (warm:false parity with the old per-turn behavior)", () => {
  it("W11: every turn is its own query call, resumed via the captured id, closed after success", async () => {
    const { queryFn, calls, closes } = scripted([OK_TURN("sess-A"), OK_TURN("sess-B", "again")]);
    const s = createSession({ queryFn, warm: false });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    await s.runTurn({ ...followUp("and now?"), onDelta: () => {} });

    expect(calls).toHaveLength(2);
    expect(closes).toEqual(expect.arrayContaining([0, 1]));
    expect(calls[1].options.resume).toBe("sess-A");
    expect(calls[1].prompts).toEqual(["and now?"]);
    expect(calls[1].prompts[0]).not.toContain("Continuity digest");
  });

  it("stale resume: retire the id and retry ONCE fresh with a digest", async () => {
    const { queryFn, calls, interrupts } = scripted([
      OK_TURN("sess-A"), // turn 1 establishes the id
      { throwAfter: 0 }, // turn 2, resumed attempt: hard-fails
      OK_TURN("sess-C", "recovered"), // turn 2, fresh retry: succeeds
    ]);
    const s = createSession({ queryFn, warm: false });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    const out = await s.runTurn({ ...followUp("continue please"), onDelta: () => {} });

    expect(calls).toHaveLength(3);
    expect(calls[1].options.resume).toBe("sess-A");
    expect(calls[2].options.resume).toBeUndefined();
    expect(calls[2].prompts[0]).toContain("Continuity digest");
    expect(out.text).toBe("recovered");
    expect(s.sessionId).toBe("sess-C");
    expect(interrupts).toContain(1); // the failed resumed attempt was disposed
  });
});

describe("turn timing (onTiming)", () => {
  const TOOL: Msg = { type: "assistant", message: { content: [{ type: "tool_use" }] } };

  it("emits one record per attempt with ordered marks and warm=false on the opening turn", async () => {
    const { queryFn } = scripted([OK_TURN("sess-A")]);
    let t = 0;
    const timings: Array<Record<string, unknown>> = [];
    const s = createSession({
      queryFn,
      now: () => (t += 100), // every clock read advances 100ms
      onTiming: (rec: Record<string, unknown>) => timings.push(rec),
    });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });

    expect(timings).toHaveLength(1);
    const rec = timings[0] as Record<string, number | boolean | string>;
    expect(rec).toMatchObject({
      v: 1,
      kind: "bridge",
      resumed: false,
      warm: false,
      ok: true,
      ackSynthetic: false,
    });
    expect(rec.initMs as number).toBeGreaterThan(0);
    expect(rec.firstDeltaMs as number).toBeGreaterThanOrEqual(rec.initMs as number);
    expect(rec.totalMs as number).toBeGreaterThanOrEqual(rec.firstDeltaMs as number);
  });

  it("W7: a warm turn is warm=true with NO initMs (there is no spawn to measure)", async () => {
    const { queryFn } = scripted([OK_TURN("sess-A"), WARM_TURN("sess-B", "again")]);
    const timings: Array<Record<string, unknown>> = [];
    const s = createSession({ queryFn, onTiming: (rec: Record<string, unknown>) => timings.push(rec) });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    await s.runTurn({ ...followUp("and now?"), onDelta: () => {} });

    expect(timings).toHaveLength(2);
    expect(timings[0]).toMatchObject({ warm: false, resumed: false, ok: true });
    expect(timings[1]).toMatchObject({ warm: true, resumed: false, ok: true });
    expect((timings[1] as Record<string, unknown>).initMs).toBeUndefined();
    const rec = timings[1] as Record<string, number>;
    expect(rec.totalMs).toBeGreaterThanOrEqual(rec.firstDeltaMs);
  });

  it("a warm-turn failure emits {warm:true, ok:false} then the resume rebuild {warm:false, resumed:true}", async () => {
    const { queryFn } = scripted([
      OK_TURN("sess-A"),
      { messages: [DELTA("x")], throwAfter: 1 }, // warm turn dies mid-stream
      OK_TURN("sess-B", "recovered"),
    ]);
    const timings: Array<Record<string, unknown>> = [];
    const s = createSession({ queryFn, onTiming: (rec: Record<string, unknown>) => timings.push(rec) });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    await s.runTurn({ ...followUp("and now?"), onDelta: () => {} });

    expect(timings).toHaveLength(3);
    expect(timings[1]).toMatchObject({ warm: true, resumed: false, ok: false });
    expect(timings[2]).toMatchObject({ warm: false, resumed: true, ok: true });
  });

  it("warm:false — a stale-resume retry emits the failed resumed attempt, then the fresh one", async () => {
    const { queryFn } = scripted([
      OK_TURN("sess-A"),
      { messages: [INIT("sess-A")], throwAfter: 1 }, // resumed attempt dies mid-stream
      OK_TURN("sess-B", "recovered"),
    ]);
    const timings: Array<Record<string, unknown>> = [];
    const s = createSession({
      queryFn,
      warm: false,
      onTiming: (rec: Record<string, unknown>) => timings.push(rec),
    });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    await s.runTurn({ ...baseTurn, hasAssistantTurns: true, onDelta: () => {} });

    expect(timings).toHaveLength(3);
    expect(timings[1]).toMatchObject({ resumed: true, warm: false, ok: false });
    expect(timings[2]).toMatchObject({ resumed: false, ok: true });
  });

  it("flags a first delta that is the synthetic tool-work acknowledgment", async () => {
    const { queryFn } = scripted([
      { messages: [INIT("sess-A"), TOOL, DELTA("done."), RESULT("sess-A", "done.")] },
    ]);
    const timings: Array<Record<string, unknown>> = [];
    const s = createSession({ queryFn, onTiming: (rec: Record<string, unknown>) => timings.push(rec) });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });

    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ ackSynthetic: true, ok: true });
  });
});
