/** @type {import('next').NextConfig} */

// LOAD-BEARING: cross-origin isolation headers.
//
// The browser-Whisper path (transformers.js + WebGPU / WASM threads) needs
// `self.crossOriginIsolated === true` so SharedArrayBuffer is available for the
// multi-threaded WASM backend. That requires BOTH of these on every document
// response:
//   Cross-Origin-Opener-Policy:   same-origin
//   Cross-Origin-Embedder-Policy: credentialless
//
// We use `credentialless` (not `require-corp`) on purpose: it still enables
// crossOriginIsolated, but lets cross-origin subresources WITHOUT a
// Cross-Origin-Resource-Policy header load (fetched credential-less) instead of
// being blocked. That keeps the Hugging Face CDN model download, any CDN fonts,
// and other third-party assets working under isolation. If a specific embed
// breaks under `credentialless`, either self-host that asset under public/ (add
// CORP) or, as a last resort, relax COEP for that route.
//
// Permissions-Policy grants this origin (and its same-origin frames)
// microphone access so getUserMedia() for push-to-talk / VAD is not blocked.
const CROSS_ORIGIN_ISOLATION_HEADERS = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
  { key: 'Permissions-Policy', value: 'microphone=(self)' },
];

const nextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) that
  // traces in only the node_modules it actually needs. This is what the
  // multi-stage Dockerfile ships as the slim self-host runtime image — see
  // Dockerfile, docker-compose.yml, and skill/agent-face/references/deploy.md.
  // Vercel ignores this and uses its own build pipeline.
  output: 'standalone',
  // Face/particle assets and social images are served as-is; skip the Image
  // Optimization pipeline so self-host (no sharp) and static export both work.
  images: {
    unoptimized: true,
  },
  // Apply the cross-origin isolation headers to ALL routes so every document
  // (and the model/worker fetches it makes) runs under crossOriginIsolated.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: CROSS_ORIGIN_ISOLATION_HEADERS,
      },
    ];
  },
};

export default nextConfig;
