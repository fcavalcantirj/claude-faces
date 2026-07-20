# Remote face checklist — opening the face from another machine

You ran the app on one machine (a Pi, a VPS, your desktop) and opened
`http://<its-ip>:3000` from another. The face renders, typed chat works — but
the talk button says **VOICE UNAVAILABLE — TYPE BELOW**. Nothing is broken:
that address is an **untrustworthy origin** (plain `http://`, not localhost),
and browsers gate the mic and cross-origin isolation on origin trust. The
server does NOT need a microphone — the mic always lives in the browser.

## What works where

| Capability | `http://<lan-or-tailnet-ip>` | HTTPS or localhost |
|---|---|---|
| Face render, emotions, lip-sync | ✅ | ✅ |
| Typed chat (any brain) | ✅ | ✅ |
| Web Speech / hosted TTS voice out | ✅ | ✅ |
| Microphone (`getUserMedia`) | ❌ hidden by the browser | ✅ |
| In-browser Whisper (threads / WebGPU) | ❌ COOP/COEP ignored | ✅ |

Two separate gates fall together on a plain-HTTP non-localhost origin:

1. `navigator.mediaDevices` is **undefined** — no mic API at all, regardless
   of hardware ([troubleshooting §1](troubleshooting.md)).
2. The COOP/COEP headers are **ignored**, so `crossOriginIsolated` stays false
   and the threaded-WASM/WebGPU Whisper path won't start
   ([troubleshooting §6](troubleshooting.md)).

## Remedies, in order of effort

1. **Tailnet (recommended):** on the machine running the app —

   ```bash
   tailscale serve --bg 3000        # adjust the port you serve on
   ```

   One command, a trusted `https://<machine>.<tailnet>.ts.net` URL on your
   tailnet, mic + isolation both work. `tailscale serve status` shows the URL;
   `tailscale serve --https=443 off` undoes it.

2. **Quick public tunnel:** `cloudflared tunnel --url http://localhost:3000`
   prints a temporary trusted HTTPS URL.

3. **Real reverse proxy:** Caddy / nginx / Traefik terminating TLS in front of
   the container — the durable self-host setup, see [`deploy.md`](deploy.md).
   Make sure the proxy passes the COOP/COEP headers through
   (check per [troubleshooting §6](troubleshooting.md)).

4. **Or just open it on the machine itself** at `http://localhost:3000` —
   localhost is always a trustworthy origin.

## Verify

```js
// browser devtools console, on the app origin
window.isSecureContext          // must be true
navigator.mediaDevices          // must be defined
self.crossOriginIsolated        // true ⇒ in-browser Whisper threads can run
```

## Dev-server note (`next dev` only)

Next dev additionally blocks cross-origin requests to its own assets/HMR from
non-localhost hosts. `next.config.mjs` auto-allows this machine's LAN IPv4s
via `allowedDevOrigins`, so opening the dev server from another device works
out of the box — but the mic/HTTPS rules above still apply. Production builds
(`next start`, Docker, Vercel) are unaffected.

Reproduced end-to-end by `tests/e2e/insecure-origin.spec.ts` (asserts the
hidden `mediaDevices`, the disabled button, and the on-screen remedy).
