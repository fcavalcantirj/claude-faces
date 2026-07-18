/** @type {import('next').NextConfig} */
const nextConfig = {
  // Face/particle assets and social images are served as-is; skip the Image
  // Optimization pipeline so self-host (no sharp) and static export both work.
  images: {
    unoptimized: true,
  },
  // NOTE: Cross-origin isolation headers (Cross-Origin-Opener-Policy /
  // Cross-Origin-Embedder-Policy / Permissions-Policy) are LOAD-BEARING for the
  // browser-Whisper (transformers.js / WebGPU + SharedArrayBuffer) path and are
  // added by the dedicated "cross-origin isolation headers" task via async
  // headers(). Intentionally left out here until that task lands.
};

export default nextConfig;
