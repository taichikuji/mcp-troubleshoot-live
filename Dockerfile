# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: download external CLI tools (kubectl, troubleshoot-live).
# Build-only deps (curl, tar, apt cache) live here and never reach runtime.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS tools

# Fail-fast shell: errexit + pipefail so failures inside pipes (e.g. the
# `curl ... | tar -xz` below) abort the build instead of being swallowed.
SHELL ["/bin/bash", "-eo", "pipefail", "-c"]

ARG KUBECTL_VERSION=v1.29.4
ARG TROUBLESHOOT_LIVE_VERSION=v0.0.20

RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      tar && \
    rm -rf /var/lib/apt/lists/*

RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
      -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL \
      "https://github.com/mhrabovcin/troubleshoot-live/releases/download/${TROUBLESHOOT_LIVE_VERSION}/troubleshoot-live_${TROUBLESHOOT_LIVE_VERSION}_linux_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin troubleshoot-live && \
    chmod +x /usr/local/bin/troubleshoot-live

# ---------------------------------------------------------------------------
# Stage 2: compile TypeScript and prune dev dependencies.
# Independent of the `tools` stage so BuildKit can run them in parallel.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# Cache mount: npm registry tarballs survive across builds, so re-runs without
# package-lock.json changes are essentially free.
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && \
    npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 3: minimal runtime image.
# No apt-get, no curl, no tar -- only the artifacts we actually need.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

COPY --from=tools /usr/local/bin/kubectl          /usr/local/bin/kubectl
COPY --from=tools /usr/local/bin/troubleshoot-live /usr/local/bin/troubleshoot-live

# --chown at COPY time avoids a separate `chown -R` layer that would duplicate
# every node_modules file and inflate the final image.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist          ./dist
COPY --chown=node:node package.json ./

# /bundles is bind-mounted from the host at runtime; we just need the
# mountpoint to exist so the container starts cleanly when no mount is given.
RUN mkdir -p /bundles && chown node:node /bundles

USER node

EXPOSE 3000

# Pure-Node health check so we don't need curl in the runtime image.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
