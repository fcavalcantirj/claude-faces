import { describe, expect, it, vi } from "vitest";
import { createPushToTalk, type RecorderLike } from "@/lib/audio/push-to-talk";

function fakeRecorder(blobSize = 16): RecorderLike & {
  startCalls: number;
  stopCalls: number;
} {
  let startCalls = 0;
  let stopCalls = 0;
  return {
    get startCalls() {
      return startCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
    async start() {
      startCalls++;
    },
    async stop() {
      stopCalls++;
      return new Blob([new Uint8Array(blobSize)], { type: "audio/webm" });
    },
  };
}

function keyEvent(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    repeat: false,
    preventDefault: vi.fn(),
    target: null,
    ...extra,
  } as unknown as KeyboardEvent;
}

describe("createPushToTalk", () => {
  it("starts on press and stops on release, delivering the blob", async () => {
    const rec = fakeRecorder();
    const onResult = vi.fn();
    const ptt = createPushToTalk({ recorder: rec, onResult });

    ptt.onKeyDown(keyEvent(" "));
    await Promise.resolve();
    expect(rec.startCalls).toBe(1);
    expect(ptt.active).toBe(true);

    ptt.onKeyUp(keyEvent(" "));
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.stopCalls).toBe(1);
    expect(ptt.active).toBe(false);
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult.mock.calls[0][0].size).toBe(16);
  });

  it("ignores key auto-repeat so a held Space records once", async () => {
    const rec = fakeRecorder();
    const ptt = createPushToTalk({ recorder: rec });

    ptt.onKeyDown(keyEvent(" "));
    ptt.onKeyDown(keyEvent(" ", { repeat: true }));
    ptt.onKeyDown(keyEvent(" ", { repeat: true }));
    await Promise.resolve();

    expect(rec.startCalls).toBe(1);
  });

  it("ignores Space while typing in an input so text entry still works", async () => {
    const rec = fakeRecorder();
    const ptt = createPushToTalk({ recorder: rec });
    const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;

    const evt = keyEvent(" ", { target: input });
    ptt.onKeyDown(evt);
    await Promise.resolve();

    expect(rec.startCalls).toBe(0);
    expect(evt.preventDefault).not.toHaveBeenCalled();
  });

  it("ignores non-Space keys", async () => {
    const rec = fakeRecorder();
    const ptt = createPushToTalk({ recorder: rec });
    ptt.onKeyDown(keyEvent("a"));
    await Promise.resolve();
    expect(rec.startCalls).toBe(0);
  });

  it("supports press-and-hold on the Talk button via pointer handlers", async () => {
    const rec = fakeRecorder();
    const onResult = vi.fn();
    const ptt = createPushToTalk({ recorder: rec, onResult });

    ptt.onPointerDown();
    await Promise.resolve();
    expect(rec.startCalls).toBe(1);

    ptt.onPointerUp();
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.stopCalls).toBe(1);
    expect(onResult).toHaveBeenCalledOnce();
  });

  it("does not deliver an empty blob (nothing captured)", async () => {
    const rec = fakeRecorder(0);
    const onResult = vi.fn();
    const ptt = createPushToTalk({ recorder: rec, onResult });

    ptt.onPointerDown();
    await Promise.resolve();
    ptt.onPointerUp();
    await Promise.resolve();
    await Promise.resolve();

    expect(rec.stopCalls).toBe(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("release without an active press is a no-op", async () => {
    const rec = fakeRecorder();
    const ptt = createPushToTalk({ recorder: rec });
    ptt.onKeyUp(keyEvent(" "));
    ptt.onPointerUp();
    await Promise.resolve();
    expect(rec.stopCalls).toBe(0);
  });

  it("routes a start failure to onError instead of throwing", async () => {
    const err = new Error("mic denied");
    const rec: RecorderLike = {
      async start() {
        throw err;
      },
      async stop() {
        return new Blob();
      },
    };
    const onError = vi.fn();
    const ptt = createPushToTalk({ recorder: rec, onError });

    ptt.onPointerDown();
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(err);
    expect(ptt.active).toBe(false);
  });
});
