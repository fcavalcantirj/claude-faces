#!/usr/bin/env node
// Self-host the hands-free VAD assets under public/vad/ so they resolve under
// the app's cross-origin-isolation headers (COOP/COEP) instead of being blocked
// as cross-origin. lib/audio/vad.ts points baseAssetPath + onnxWASMBasePath at
// `/vad/`, and this copies the exact files that path serves:
//
//   - @ricky0123/vad-web: the AudioWorklet bundle + the Silero ONNX model(s)
//   - onnxruntime-web:     the wasm the ORT runtime loads (default + jsep/webgpu)
//
// The files are large binaries pulled from node_modules, so public/vad/ is
// gitignored and (re)generated here. It runs on `predev`/`prebuild` (locally and
// on Vercel) so the assets are always present before `next dev`/`next build`.
// Idempotent: a file already present at the right size is skipped.

import { existsSync, mkdirSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dest = join(root, "public", "vad");

const vadDist = join(root, "node_modules", "@ricky0123", "vad-web", "dist");
const ortDist = join(root, "node_modules", "onnxruntime-web", "dist");

// The assets `/vad/` must serve. onnxruntime-web ships many builds; we only need
// the threaded wasm (default) + jsep wasm (WebGPU) and their loader shims.
const sources = [
  join(vadDist, "vad.worklet.bundle.min.js"),
  join(vadDist, "silero_vad_legacy.onnx"),
  join(vadDist, "silero_vad_v5.onnx"),
  join(ortDist, "ort-wasm-simd-threaded.wasm"),
  join(ortDist, "ort-wasm-simd-threaded.mjs"),
  join(ortDist, "ort-wasm-simd-threaded.jsep.wasm"),
  join(ortDist, "ort-wasm-simd-threaded.jsep.mjs"),
];

function copyOne(src) {
  const name = basename(src);
  const target = join(dest, name);
  if (!existsSync(src)) {
    console.warn(`[vad-assets] MISSING source (skipped): ${src}`);
    return false;
  }
  if (existsSync(target) && statSync(target).size === statSync(src).size) {
    return true; // already up to date
  }
  copyFileSync(src, target);
  console.log(`[vad-assets] copied ${name}`);
  return true;
}

function main() {
  mkdirSync(dest, { recursive: true });
  let ok = 0;
  for (const src of sources) if (copyOne(src)) ok++;
  console.log(`[vad-assets] ${ok}/${sources.length} assets ready in public/vad/`);
  // Never fail the build if the optional VAD dep isn't installed — hands-free is
  // an opt-in mode; push-to-talk works without these assets.
}

main();
