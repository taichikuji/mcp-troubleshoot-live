# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && \
    npm prune --omit=dev

FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update -y && \
    apt-get install -y --no-install-recommends curl ca-certificates tar && \
    rm -rf /var/lib/apt/lists/*

ARG KUBECTL_VERSION=v1.29.4
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" \
      -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

ARG TROUBLESHOOT_LIVE_VERSION=v0.0.20
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL \
      "https://github.com/mhrabovcin/troubleshoot-live/releases/download/${TROUBLESHOOT_LIVE_VERSION}/troubleshoot-live_${TROUBLESHOOT_LIVE_VERSION}_linux_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin troubleshoot-live && \
    chmod +x /usr/local/bin/troubleshoot-live

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# /bundles holds support bundles (mounted from the host).
# /cache/kubebuilder-envtest caches envtest binaries (kube-apiserver + etcd)
# downloaded by troubleshoot-live on first run; mount a named volume here.
RUN mkdir -p /bundles /cache/kubebuilder-envtest && \
    chown -R node:node /app /bundles /cache

ENV KUBEBUILDER_ASSETS=/cache/kubebuilder-envtest

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
