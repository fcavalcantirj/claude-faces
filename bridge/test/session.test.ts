// @vitest-environment node
//
// The session state machine: one-shot query() per request, resumed via the
// captured session id. The failure discipline mirrors hermes-agent:
//   • fresh conversation (no assistant turns in the replayed history) → fresh
//   • assistant turns + stored id → resume
//   • assistant turns + NO stored id (bridge restarted) → fresh + digest
//   • a RESUMED attempt that throws → retire the id, retry ONCE fresh + digest
//   • a FRESH attempt that throws → no retry, surface the error
// And the teardown discipline: every exit path (success, error, abort,
// timeout) reaches dispose(), because the real SDK owns a Claude Code CLI
// subprocess that leaks otherwise.

import { describe, it, expect } from "vitest";
import { createSession } from "../src/session.mjs";

type Msg = Record<string, unknown>;
interface Script {
  messages?: Msg[];
  throwAfter?: number; // throw after yielding this many messages
  hang?: boolean; // never finish after yielding all messages
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

const OK_TURN = (id = "sess-A", text = "hello"): Script => ({
  messages: [INIT(id), DELTA("hel"), DELTA("lo"), RESULT(id, text)],
});

/** Scripted queryFn: call N runs scripts[N] (last script repeats). */
function scripted(scripts: Script[]) {
  const calls: Array<{ prompt: string; options: Record<string, any> }> = [];
  const interrupts: number[] = [];
  const returns: number[] = [];
  const queryFn = ({ prompt, options }: { prompt: string; options: Record<string, any> }) => {
    const idx = calls.length;
    calls.push({ prompt, options });
    const script = scripts[Math.min(idx, scripts.length - 1)];
    const gen = (async function* () {
      let yielded = 0;
      for (const m of script.messages ?? []) {
        if (script.throwAfter !== undefined && yielded >= script.throwAfter) break;
        yield m;
        yielded += 1;
      }
      if (script.throwAfter !== undefined) throw new Error("SDK query failed (scripted)");
      if (script.hang) await new Promise(() => {});
    })();
    (gen as any).interrupt = async () => {
      interrupts.push(idx);
    };
    const origReturn = gen.return.bind(gen);
    (gen as any).return = async (v?: unknown) => {
      returns.push(idx);
      return origReturn(v as never);
    };
    return gen;
  };
  return { queryFn, calls, interrupts, returns };
}

const baseTurn = {
  latestUserText: "what is up?",
  systemText: "be brief",
  hasAssistantTurns: false,
  messages: [{ role: "user", content: "what is up?" }],
};

describe("createSession.runTurn", () => {
  it("fresh conversation: no resume, preset system prompt, deltas forwarded, result returned", async () => {
    const { queryFn, calls } = scripted([OK_TURN()]);
    const s = createSession({ queryFn, model: "claude-sonnet-5", permissionMode: "acceptEdits" });
    const deltas: string[] = [];
    const out = await s.runTurn({ ...baseTurn, onDelta: (t: string) => deltas.push(t) });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("what is up?");
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

  it("second turn resumes with the captured session id and sends ONLY the latest user text", async () => {
    const { queryFn, calls } = scripted([OK_TURN("sess-A")]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    await s.runTurn({
      ...baseTurn,
      latestUserText: "and now?",
      hasAssistantTurns: true,
      messages: [
        { role: "user", content: "what is up?" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "and now?" },
      ],
      onDelta: () => {},
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe("sess-A");
    expect(calls[1].prompt).toBe("and now?");
    expect(calls[1].prompt).not.toContain("Continuity digest");
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
    expect(calls[0].prompt).toContain("Continuity digest");
    expect(calls[0].prompt).toContain("earlier answer");
    expect(calls[0].prompt).toMatch(/where were we\?$/);
  });

  it("a NEW conversation retires the stored id (no resume, no digest)", async () => {
    const { queryFn, calls } = scripted([OK_TURN("sess-A")]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, hasAssistantTurns: true, onDelta: () => {} });
    // The user hit "new conversation": history has no assistant turns again.
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    expect(calls[1].options.resume).toBeUndefined();
    expect(calls[1].prompt).toBe("what is up?");
  });

  it("stale resume: retire the id and retry ONCE fresh with a digest", async () => {
    const { queryFn, calls, interrupts } = scripted([
      OK_TURN("sess-A"), // turn 1 establishes the id
      { throwAfter: 0 }, // turn 2, resumed attempt: hard-fails
      OK_TURN("sess-C", "recovered"), // turn 2, fresh retry: succeeds
    ]);
    const s = createSession({ queryFn });
    await s.runTurn({ ...baseTurn, onDelta: () => {} });
    const out = await s.runTurn({
      ...baseTurn,
      latestUserText: "continue please",
      hasAssistantTurns: true,
      messages: [
        { role: "user", content: "what is up?" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "continue please" },
      ],
      onDelta: () => {},
    });
    expect(calls).toHaveLength(3);
    expect(calls[1].options.resume).toBe("sess-A");
    expect(calls[2].options.resume).toBeUndefined();
    expect(calls[2].prompt).toContain("Continuity digest");
    expect(out.text).toBe("recovered");
    expect(s.sessionId).toBe("sess-C");
    expect(interrupts).toContain(1); // the failed resumed attempt was disposed
  });

  it("a FRESH attempt that fails does NOT retry", async () => {
    const { queryFn, calls } = scripted([{ throwAfter: 0 }]);
    const s = createSession({ queryFn });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/scripted/);
    expect(calls).toHaveLength(1);
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
    const { queryFn } = scripted([{ messages: [INIT("s"), DELTA("half")] }]);
    const s = createSession({ queryFn });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/without a result/i);
  });

  it("client abort mid-stream interrupts and disposes the query", async () => {
    const { queryFn, interrupts, returns } = scripted([
      { messages: [INIT("s"), DELTA("par")], hang: true },
    ]);
    const s = createSession({ queryFn });
    const ac = new AbortController();
    const turn = s.runTurn({
      ...baseTurn,
      signal: ac.signal,
      onDelta: () => setTimeout(() => ac.abort(), 5),
    });
    await expect(turn).rejects.toThrow(/abort/i);
    expect(interrupts).toContain(0);
    expect(returns).toContain(0);
  });

  it("turn timeout interrupts and disposes the query", async () => {
    const { queryFn, interrupts } = scripted([{ messages: [INIT("s"), DELTA("x")], hang: true }]);
    const s = createSession({ queryFn, turnTimeoutMs: 80, initTimeoutMs: 60 });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/timed out/i);
    expect(interrupts).toContain(0);
  });

  it("init timeout (no first message) interrupts and disposes the query", async () => {
    const { queryFn, interrupts } = scripted([{ messages: [], hang: true }]);
    const s = createSession({ queryFn, initTimeoutMs: 50, turnTimeoutMs: 5_000 });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/timed out/i);
    expect(interrupts).toContain(0);
  });

  it("an error thrown mid-stream still disposes the query", async () => {
    const { queryFn, interrupts } = scripted([{ messages: [INIT("s"), DELTA("x")], throwAfter: 2 }]);
    const s = createSession({ queryFn });
    await expect(s.runTurn({ ...baseTurn, onDelta: () => {} })).rejects.toThrow(/scripted/);
    expect(interrupts).toContain(0);
  });
});
