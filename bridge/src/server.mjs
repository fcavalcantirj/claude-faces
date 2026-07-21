// The HTTP surface: POST /v1/chat/completions (SSE or aggregated) and
// GET /healthz, on 127.0.0.1 by default. One turn at a time — the bridge
// fronts ONE personal agent, so a second concurrent request briefly waits for
// the lock and then 429s rather than interleaving two conversations into one
// session. Client disconnect (barge-in aborts the fetch) aborts the running
// SDK query so the CLI subprocess never keeps generating for a closed socket.

import http from "node:http";
import { pathToFileURL } from "node:url";

import { assertSubscriptionAuth, loadEnv } from "./env.mjs";
import { errorBody, HttpError, parseChatRequest } from "./openai-http.mjs";
import { createSseWriter } from "./sse.mjs";
import { BridgeAbortError, createSession } from "./session.mjs";
import { loadQuery } from "./sdk.mjs";

export function createBridgeServer({ env, queryFn, log = () => {}, lockWaitMs = 5_000 }) {
  const session = createSession({
    queryFn,
    model: env.model,
    permissionMode: env.permissionMode,
    cwd: env.cwd,
    warm: env.warm,
    // One log line per attempt: spawn+resume+TTFT attribution for the
    // measurement sessions (undefined marks are dropped by stringify).
    onTiming: (t) => log("[bridge-timing] " + JSON.stringify(t)),
  });

  let busy = false;
  let releaseTurn = () => {};
  let turnDone = Promise.resolve();

  async function acquireTurn() {
    if (busy) {
      await Promise.race([turnDone, new Promise((r) => setTimeout(r, lockWaitMs))]);
      if (busy) {
        throw new HttpError(429, "The bridge is answering another turn; retry shortly.");
      }
    }
    busy = true;
    turnDone = new Promise((resolve) => {
      releaseTurn = resolve;
    });
  }

  function release() {
    busy = false;
    releaseTurn();
  }

  async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2_000_000) throw new HttpError(413, "Request body too large.");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "Request body must be a JSON object.");
    }
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  async function handleChat(req, res) {
    if (env.token) {
      if ((req.headers.authorization ?? "") !== `Bearer ${env.token}`) {
        throw new HttpError(401, "Missing or wrong bearer token.");
      }
    }
    const parsed = parseChatRequest(await readJsonBody(req));
    await acquireTurn();

    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) ac.abort();
    };
    res.on("close", onClose);

    const turnArgs = {
      latestUserText: parsed.latestUserText,
      systemText: parsed.systemText,
      hasAssistantTurns: parsed.hasAssistantTurns,
      messages: parsed.messages,
      signal: ac.signal,
    };

    try {
      if (parsed.stream) {
        const writer = createSseWriter(res, { model: parsed.model });
        writer.start();
        try {
          const out = await session.runTurn({ ...turnArgs, onDelta: (t) => writer.delta(t) });
          writer.finish({ finishReason: out.finishReason, usage: out.usage });
          writer.done();
          res.end();
        } catch (err) {
          writer.stop();
          if (err instanceof BridgeAbortError) {
            res.end();
            return;
          }
          log(`turn failed: ${err?.message ?? err}`);
          // Headers are long gone — surface the failure in-band and terminate.
          writer.finish({ finishReason: "error" });
          writer.done();
          res.end();
        }
      } else {
        const parts = [];
        const out = await session.runTurn({ ...turnArgs, onDelta: (t) => parts.push(t) });
        sendJson(res, 200, {
          id: `chatcmpl-${Date.now().toString(36)}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: out.text || parts.join("") },
              finish_reason: out.finishReason,
            },
          ],
          ...(out.usage ? { usage: out.usage } : {}),
        });
      }
    } finally {
      res.off("close", onClose);
      release();
    }
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.split("?")[0] === "/healthz") {
      sendJson(res, 200, { ok: true, busy });
      return;
    }
    if (req.method === "POST" && url.split("?")[0] === "/v1/chat/completions") {
      handleChat(req, res).catch((err) => {
        if (res.headersSent) {
          log(`late failure: ${err?.message ?? err}`);
          try {
            res.end();
          } catch {
            /* socket already gone */
          }
          return;
        }
        const status = err instanceof HttpError ? err.status : 500;
        sendJson(res, status, errorBody(err));
      });
      return;
    }
    sendJson(res, 404, {
      error: { message: `No route: ${req.method} ${url}`, type: "invalid_request_error" },
    });
  });

  return { server, session };
}

export async function main() {
  // Fail closed BEFORE loading the SDK: a metered key must never get as far
  // as a subprocess that would silently prefer it over the subscription.
  assertSubscriptionAuth(process.env);
  const env = loadEnv(process.env);
  const queryFn = await loadQuery();
  const { server, session } = createBridgeServer({
    env,
    queryFn,
    log: (line) => console.error(`[bridge] ${line}`),
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(env.port, env.host, () => resolve());
  });
  console.error(`claude-agent-bridge listening on http://${env.host}:${env.port}`);
  console.error(
    "auth: Claude Code subscription login — the SDK subprocess self-authenticates; this bridge holds no credentials",
  );
  console.error(
    `permission mode: ${env.permissionMode}${env.model ? ` · model: ${env.model}` : ""}${env.token ? " · bearer token required" : ""}`,
  );

  const shutdown = () => {
    console.error("[bridge] shutting down");
    // Reap the warm SDK subprocess FIRST (synchronous abort+close) — the HTTP
    // server owns no child processes; the session does.
    session.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}
