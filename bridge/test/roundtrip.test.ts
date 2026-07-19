// @vitest-environment node
//
// The seam-closing test: the REAL app adapter (lib/providers/agent-bridge.ts,
// AGENT_BRIDGE_KIND=claude-code) talks to a REAL in-process bridge server over
// real HTTP — only the Agent SDK itself is a scripted fake. If the bridge's
// SSE writer and the app's SSE parser ever disagree, this fails; no live agent
// or subscription login is needed.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createBridgeServer } from "../src/server.mjs";
import { loadEnv } from "../src/env.mjs";
import { createAgentBridgeAdapter } from "@/lib/providers/agent-bridge";
import { AdapterError, type StreamEvent } from "@/lib/providers/types";

type Msg = Record<string, unknown>;
const INIT: Msg = { type: "system", subtype: "init", session_id: "sess-rt" };
const DELTA = (text: string): Msg => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const RESULT: Msg = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "hello from your agent",
  session_id: "sess-rt",
  usage: { input_tokens: 2, output_tokens: 5 },
};

/** Default scripted query: a normal three-delta turn. */
function okQuery() {
  return (async function* () {
    yield INIT;
    yield DELTA("hello ");
    yield DELTA("from your ");
    yield DELTA("agent");
    yield RESULT;
  })();
}

let hangResolve: (() => void) | null = null;
/** A query that yields one delta then hangs until released (for the turn lock test). */
function hangingQuery() {
  const gen = (async function* () {
    yield INIT;
    yield DELTA("busy...");
    await new Promise<void>((resolve) => {
      hangResolve = resolve;
    });
    yield RESULT;
  })();
  (gen as any).interrupt = async () => hangResolve?.();
  return gen;
}

let mode: "ok" | "hang" = "ok";
const queryFn = () => (mode === "hang" ? hangingQuery() : okQuery());

let baseUrl = "";
let server: ReturnType<typeof createBridgeServer>["server"];

beforeAll(async () => {
  const created = createBridgeServer({
    env: loadEnv({ CLAUDE_BRIDGE_TOKEN: "sekret" }),
    queryFn,
    lockWaitMs: 50,
  });
  server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  hangResolve?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const appEnv = (over: Record<string, string> = {}) => ({
  AGENT_BRIDGE_KIND: "claude-code",
  AGENT_BRIDGE_URL: baseUrl,
  AGENT_BRIDGE_KEY: "sekret",
  ...over,
});

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("round trip: real adapter ↔ real bridge server (fake SDK)", () => {
  it("streams deltas the adapter reassembles into the reply, then done", async () => {
    mode = "ok";
    const adapter = createAgentBridgeAdapter();
    const events = await collect(
      adapter.streamChat(
        { messages: [{ role: "user", content: "hi" }], system: "be brief" },
        appEnv(),
      ),
    );
    const text = events
      .filter((e) => e.type === "delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("hello from your agent");
    expect(events[events.length - 1]).toMatchObject({ type: "done" });
  });

  it("rejects a wrong bearer token as unauthorized", async () => {
    mode = "ok";
    const adapter = createAgentBridgeAdapter();
    await expect(
      collect(
        adapter.streamChat(
          { messages: [{ role: "user", content: "hi" }] },
          appEnv({ AGENT_BRIDGE_KEY: "wrong" }),
        ),
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("unauthorized");
      return true;
    });
  });

  it("a concurrent second turn is rate-limited by the turn lock", async () => {
    mode = "hang";
    const adapter = createAgentBridgeAdapter();
    const ac = new AbortController();
    const first = collect(
      adapter.streamChat(
        { messages: [{ role: "user", content: "slow one" }], signal: ac.signal },
        appEnv(),
      ),
    ).catch((err) => err);
    // Give the first request time to take the lock.
    await new Promise((r) => setTimeout(r, 100));
    mode = "ok";
    await expect(
      collect(adapter.streamChat({ messages: [{ role: "user", content: "second" }] }, appEnv())),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe("rate_limited");
      return true;
    });
    ac.abort();
    hangResolve?.();
    await first; // barge-in path: aborting must release the turn
  });

  it("after an aborted turn the lock is released for the next request", async () => {
    mode = "ok";
    const adapter = createAgentBridgeAdapter();
    const events = await collect(
      adapter.streamChat({ messages: [{ role: "user", content: "again" }] }, appEnv()),
    );
    expect(events[events.length - 1]).toMatchObject({ type: "done" });
  });

  it("GET /healthz answers without auth", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("stream:false aggregates into a plain chat.completion (curl smoke path)", async () => {
    mode = "ok";
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sekret" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "hello from your agent" });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBe(7);
  });

  it("a malformed body is a 400 with an OpenAI-style error object", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer sekret" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.message).toMatch(/messages/);
  });

  it("unknown routes 404", async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(404);
  });
});
