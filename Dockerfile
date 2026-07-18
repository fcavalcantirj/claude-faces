# syntax=docker/dockerfile:1
# ============================================================================
# claude-faces — self-host image (multi-stage: deps -> build -> runtime)
# ============================================================================
# Builds a slim runtime image around Next.js `output: 'standalone'`.
# Meant to run on your OWN VPS, right next to your agent, so Mode B
# (the agent-bridge brain) reaches the agent over the private network with
# NO public tunnel. See skill/agent-face/references/deploy.md.
#
#   docker build -t claude-faces .
#   docker run --rm -p 3000:3000 --env-file .env.local claude-faces
# ----------------------------------------------------------------------------

# Pin to the Node 22 line (matches .nvmrc — Next.js 16 requirement).
ARG NODE_VERSION=22

# --- Stage 1: install dependencies -----------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
# Only the manifests, so this layer caches until dependencies actually change.
COPY package.json package-lock.json ./
# Reproducible, lockfile-exact install including devDeps (needed to build).
RUN npm ci

# --- Stage 2: build the standalone server ----------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `prebuild` (scripts/setup-vad-assets.mjs) copies the hands-free VAD/ONNX
# assets from node_modules into public/vad/ before `next build` runs, so they
# land in the public/ we ship below. `next build` then emits .next/standalone.
RUN npm run build

# --- Stage 3: minimal runtime ----------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone server reads PORT/HOSTNAME; bind to all interfaces so the
# published container port is reachable. Override PORT via the environment.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as a non-root user.
RUN addgroup -g 1001 -S nodejs \
  && adduser -u 1001 -S nextjs -G nodejs

# Static + public assets are NOT bundled into the standalone trace — copy them
# alongside server.js exactly where Next expects them at runtime.
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# node server.js is the standalone entrypoint (its own minimal http server —
# no `next start`, no full node_modules needed).
CMD ["node", "server.js"]
