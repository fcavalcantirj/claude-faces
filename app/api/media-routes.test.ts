// Wiring guards for the two media routes.
//
// /api/transcribe and /api/tts are deliberately 4-line shims — all their logic
// lives in lib/stt/hosted.ts and lib/tts/hosted.ts, which carry their own tests.
// So this file does NOT re-test that logic. It guards the two things the shims
// alone are responsible for, both of which are silent-breakage risks:
//
//   1. `runtime = 'nodejs'`. Flipping to the edge runtime would break multipart
//      form-data parsing (transcribe) and byte streaming (tts) at RUNTIME ONLY —
//      it typechecks, builds, and deploys perfectly, then fails in production.
//   2. that POST actually delegates, passing the real process.env through.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/stt/hosted", () => ({
  transcribeHosted: vi.fn(async () => new Response("stt-ok", { status: 200 })),
}));
vi.mock("@/lib/tts/hosted", () => ({
  synthesizeHosted: vi.fn(async () => new Response("tts-ok", { status: 200 })),
}));

import { transcribeHosted } from "@/lib/stt/hosted";
import { synthesizeHosted } from "@/lib/tts/hosted";
import * as transcribeRoute from "@/app/api/transcribe/route";
import * as ttsRoute from "@/app/api/tts/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/transcribe", () => {
  it("runs on the Node runtime (edge cannot parse multipart uploads)", () => {
    expect(transcribeRoute.runtime).toBe("nodejs");
  });

  it("allows enough duration for an upstream transcription", () => {
    expect(transcribeRoute.maxDuration).toBeGreaterThanOrEqual(60);
  });

  it("delegates to transcribeHosted with the server env", async () => {
    const req = new Request("http://localhost/api/transcribe", { method: "POST" });
    const res = await transcribeRoute.POST(req);

    expect(transcribeHosted).toHaveBeenCalledOnce();
    const [passedReq, opts] = vi.mocked(transcribeHosted).mock.calls[0];
    expect(passedReq).toBe(req);
    expect(opts?.env).toBe(process.env);
    expect(await res.text()).toBe("stt-ok");
  });
});

describe("/api/tts", () => {
  it("runs on the Node runtime (edge cannot stream the audio body the same way)", () => {
    expect(ttsRoute.runtime).toBe("nodejs");
  });

  it("allows enough duration for a longer utterance", () => {
    expect(ttsRoute.maxDuration).toBeGreaterThanOrEqual(60);
  });

  it("delegates to synthesizeHosted with the server env", async () => {
    const req = new Request("http://localhost/api/tts", { method: "POST" });
    const res = await ttsRoute.POST(req);

    expect(synthesizeHosted).toHaveBeenCalledOnce();
    const [passedReq, opts] = vi.mocked(synthesizeHosted).mock.calls[0];
    expect(passedReq).toBe(req);
    expect(opts?.env).toBe(process.env);
    expect(await res.text()).toBe("tts-ok");
  });
});
