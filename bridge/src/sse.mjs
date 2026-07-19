// OpenAI chat.completion.chunk SSE writer. The consuming parser is the app's
// eventsource-parser pipeline (lib/providers/sse.ts): ": keepalive" comment
// lines never reach it and "data: [DONE]" is swallowed there, so both are safe
// on the wire. The 30s keepalive comment exists because a Claude Code turn can
// think/tool-use for minutes with no token output, and idle proxies kill
// silent connections.

/**
 * @param {{ writeHead: Function, write: (chunk: string) => boolean, flushHeaders?: Function }} res
 * @param {{ model?: string, keepaliveMs?: number }} [options]
 */
export function createSseWriter(res, { model, keepaliveMs = 30_000 } = {}) {
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  let lastActivity = Date.now();
  let interval = null;

  function writeFrame(payload) {
    lastActivity = Date.now();
    res.write(payload);
  }

  function chunk(delta, finishReason = null, usage) {
    const obj = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) obj.usage = usage;
    writeFrame(`data: ${JSON.stringify(obj)}\n\n`);
  }

  return {
    /** Headers + the role chunk, then arm the keepalive timer. */
    start() {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      chunk({ role: "assistant" });
      const tick = Math.min(1_000, keepaliveMs);
      interval = setInterval(() => {
        if (Date.now() - lastActivity >= keepaliveMs) writeFrame(": keepalive\n\n");
      }, tick);
      interval.unref?.();
    },

    delta(text) {
      chunk({ content: text });
    },

    /**
     * @param {{ finishReason?: string, usage?: { prompt_tokens: number, completion_tokens: number, total_tokens: number } }} [outcome]
     */
    finish({ finishReason = "stop", usage } = {}) {
      chunk({}, finishReason, usage);
    },

    /** The terminator; also silences the keepalive timer. */
    done() {
      writeFrame("data: [DONE]\n\n");
      this.stop();
    },

    /** Stop the keepalive timer without writing (abort/teardown path). */
    stop() {
      if (interval) clearInterval(interval);
      interval = null;
    },
  };
}
