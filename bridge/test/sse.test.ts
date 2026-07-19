// @vitest-environment node
//
// The OpenAI chat.completion.chunk SSE writer. The consuming parser is the
// app's eventsource-parser pipeline (lib/providers/sse.ts): comment lines
// (": keepalive") never reach onEvent and "data: [DONE]" is swallowed — so the
// contract asserted here is exactly what lib/providers/agent-bridge.ts reads:
// choices[0].delta.content for text and a non-empty finish_reason to stop.

import { describe, it, expect, vi, afterEach } from "vitest";
import { createSseWriter } from "../src/sse.mjs";

interface FakeRes {
  chunks: string[];
  statusCode: number;
  headers: Record<string, unknown>;
  headersSent: boolean;
  ended: boolean;
  writeHead: (code: number, headers: Record<string, unknown>) => FakeRes;
  write: (c: string) => boolean;
  end: (c?: string) => void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    chunks: [],
    statusCode: 0,
    headers: {},
    headersSent: false,
    ended: false,
    writeHead(code, headers) {
      res.statusCode = code;
      res.headers = headers;
      res.headersSent = true;
      return res;
    },
    write(c) {
      res.chunks.push(String(c));
      return true;
    },
    end(c) {
      if (c) res.chunks.push(String(c));
      res.ended = true;
    },
  };
  return res;
}

/** Split the written stream into SSE frames; parse data frames as JSON. */
function frames(res: FakeRes): string[] {
  return res.chunks.join("").split("\n\n").filter((f) => f.length > 0);
}
function dataFrames(res: FakeRes): unknown[] {
  return frames(res)
    .filter((f) => f.startsWith("data: ") && !f.includes("[DONE]"))
    .map((f) => JSON.parse(f.slice("data: ".length)));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSseWriter", () => {
  it("start() writes SSE headers and the role chunk first", () => {
    const res = fakeRes();
    const w = createSseWriter(res, { model: "claude-code" });
    w.start();
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.headers["Cache-Control"]).toBe("no-cache");
    const [role] = dataFrames(res) as Array<{
      object: string;
      model: string;
      choices: Array<{ delta: Record<string, unknown>; finish_reason: null }>;
    }>;
    expect(role.object).toBe("chat.completion.chunk");
    expect(role.model).toBe("claude-code");
    expect(role.choices[0].delta).toEqual({ role: "assistant" });
    expect(role.choices[0].finish_reason).toBeNull();
    w.stop();
  });

  it("delta() writes content chunks the app adapter can read", () => {
    const res = fakeRes();
    const w = createSseWriter(res, { model: "m" });
    w.start();
    w.delta("hel");
    w.delta("lo");
    const all = dataFrames(res) as Array<{ choices: Array<{ delta: { content?: string } }> }>;
    const texts = all.map((c) => c.choices[0].delta.content).filter(Boolean);
    expect(texts).toEqual(["hel", "lo"]);
    w.stop();
  });

  it("finish() carries finish_reason + usage; done() writes [DONE]", () => {
    const res = fakeRes();
    const w = createSseWriter(res, { model: "m" });
    w.start();
    w.delta("hi");
    w.finish({
      finishReason: "stop",
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    w.done();
    const all = dataFrames(res) as Array<{
      choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>;
      usage?: unknown;
    }>;
    const fin = all[all.length - 1];
    expect(fin.choices[0].finish_reason).toBe("stop");
    expect(fin.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(frames(res)[frames(res).length - 1]).toBe("data: [DONE]");
  });

  it("all chunks share one id and use the same object type", () => {
    const res = fakeRes();
    const w = createSseWriter(res, { model: "m" });
    w.start();
    w.delta("a");
    w.finish({});
    const all = dataFrames(res) as Array<{ id: string; object: string }>;
    expect(new Set(all.map((c) => c.id)).size).toBe(1);
    expect(all.every((c) => c.object === "chat.completion.chunk")).toBe(true);
    w.stop();
  });

  it("writes a ': keepalive' comment after 30s of inactivity — and only then", () => {
    vi.useFakeTimers();
    const res = fakeRes();
    const w = createSseWriter(res, { model: "m", keepaliveMs: 30_000 });
    w.start();
    vi.advanceTimersByTime(29_000);
    expect(res.chunks.join("")).not.toContain(": keepalive");
    vi.advanceTimersByTime(2_000);
    expect(res.chunks.join("")).toContain(": keepalive");
    w.stop();
  });

  it("activity resets the keepalive clock", () => {
    vi.useFakeTimers();
    const res = fakeRes();
    const w = createSseWriter(res, { model: "m", keepaliveMs: 30_000 });
    w.start();
    vi.advanceTimersByTime(20_000);
    w.delta("still here");
    vi.advanceTimersByTime(20_000); // 40s since start, 20s since delta
    expect(res.chunks.join("")).not.toContain(": keepalive");
    w.stop();
  });

  it("stop() silences the timer (no writes after the response is over)", () => {
    vi.useFakeTimers();
    const res = fakeRes();
    const w = createSseWriter(res, { model: "m", keepaliveMs: 1_000 });
    w.start();
    w.stop();
    const before = res.chunks.length;
    vi.advanceTimersByTime(10_000);
    expect(res.chunks.length).toBe(before);
  });
});
