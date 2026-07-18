// End-to-end streaming chat eval: adapter → /api/chat → SSE wire → browser client.
//
// app/api/chat/route.test.ts and lib/chat/client.test.ts are both thorough, but
// they test the two halves SEPARATELY — the route against a hand-rolled adapter,
// the client against a hand-rolled SSE stream. Neither proves the halves actually
// COMPOSE: that what the route really emits is what the client really parses.
//
// This eval closes that gap. It registers the shared mock adapter into the real
// registry, pipes the REAL route Response into the REAL streamChat client, and
// asserts the full loop. No network, no provider keys, no fabricated SSE.

import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/chat/route";
import { registerAdapter, unregisterAdapter, AdapterError } from "@/lib/providers";
import { runChat, streamChat } from "@/lib/chat/client";
import { createMockAdapter } from "./helpers/mock-adapter";

const PROVIDER = "eval-mock";

/**
 * A `fetch` that routes straight into the real route handler, so the client
 * consumes exactly the bytes the server produces.
 */
const routeFetch: typeof fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const req = new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: init?.body as BodyInit,
    signal: init?.signal,
  });
  return POST(req);
}) as unknown as typeof fetch;

const baseOptions = {
  provider: PROVIDER,
  messages: [{ role: "user" as const, content: "hello" }],
  fetchImpl: routeFetch,
};

afterEach(() => {
  unregisterAdapter(PROVIDER);
  vi.restoreAllMocks();
});

describe("adapter → route → client compose", () => {
  it("delivers every delta through the real SSE wire, in order", async () => {
    registerAdapter(PROVIDER, () =>
      createMockAdapter({ id: PROVIDER, deltas: ["Hello", " there", "."] }),
    );

    const seen: string[] = [];
    for await (const delta of streamChat(baseOptions)) seen.push(delta);

    expect(seen).toEqual(["Hello", " there", "."]);
  });

  it("hands the first sentence to TTS BEFORE the stream completes", async () => {
    registerAdapter(PROVIDER, () =>
      createMockAdapter({
        id: PROVIDER,
        // Two sentences: the first must be dispatched while the second is still
        // arriving — that early handoff is what makes the face start talking
        // before the model has finished thinking.
        deltas: ["Hello there. ", "How are you", " today?"],
      }),
    );

    const log: string[] = [];
    const session = runChat(baseOptions, {
      onSentence: (s) => log.push(`sentence:${s.trim()}`),
      onDone: () => log.push("done"),
    });
    await session.done;

    const firstSentenceAt = log.findIndex((e) => e.startsWith("sentence:"));
    const doneAt = log.indexOf("done");

    expect(firstSentenceAt).toBeGreaterThanOrEqual(0);
    expect(doneAt).toBeGreaterThanOrEqual(0);
    // The assertion that matters: strictly before, not merely present.
    expect(firstSentenceAt).toBeLessThan(doneAt);
    expect(log[firstSentenceAt]).toBe("sentence:Hello there.");
  });

  it("strips a trailing [[face:x]] directive from spoken text but keeps it in raw", async () => {
    registerAdapter(PROVIDER, () =>
      createMockAdapter({
        id: PROVIDER,
        deltas: ["That is wonderful news.", "[[face:happy]]"],
      }),
    );

    const spoken: string[] = [];
    const result = await runChat(baseOptions, {
      onSentence: (s) => spoken.push(s),
    }).done;

    expect(result.raw).toContain("[[face:happy]]");
    expect(result.text).not.toContain("[[face:");
    expect(result.text).toContain("That is wonderful news.");
    expect(result.emotion).toBe("happy");
    // TTS must never be asked to pronounce the directive.
    for (const s of spoken) expect(s).not.toContain("[[face:");
  });

  it("surfaces a typed AdapterError when the adapter fails mid-stream", async () => {
    registerAdapter(PROVIDER, () =>
      createMockAdapter({
        id: PROVIDER,
        deltas: ["partial"],
        error: { code: "upstream_error", message: "provider exploded" },
      }),
    );

    await expect(async () => {
      for await (const _ of streamChat(baseOptions)) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(AdapterError);
  });

  it("propagates a client abort all the way into adapter cancellation", async () => {
    const controller = new AbortController();
    let deltasProduced = 0;

    registerAdapter(PROVIDER, () =>
      createMockAdapter({
        id: PROVIDER,
        deltas: ["one ", "two ", "three ", "four ", "five "],
        onDelta: async (i) => {
          deltasProduced = i + 1;
          // Abort partway: the adapter must stop producing, not run to the end.
          if (i === 1) controller.abort();
          await new Promise((r) => setTimeout(r, 5));
        },
      }),
    );

    const received: string[] = [];
    try {
      for await (const d of streamChat({ ...baseOptions, signal: controller.signal })) {
        received.push(d);
      }
    } catch {
      /* abort surfaces as a throw or a clean stop depending on timing */
    }

    // Both bounds matter. The lower bound proves the adapter actually STARTED
    // (without it this passes vacuously when nothing ever runs); the upper bound
    // proves cancellation genuinely reached it and stopped production early.
    expect(deltasProduced).toBeGreaterThanOrEqual(1);
    expect(deltasProduced).toBeLessThan(5);
    expect(received.length).toBeLessThan(5);
  });

  it("returns a machine-readable error for an unknown provider", async () => {
    await expect(async () => {
      for await (const _ of streamChat({ ...baseOptions, provider: "does-not-exist" })) {
        /* drain */
      }
    }).rejects.toBeInstanceOf(AdapterError);
  });
});
