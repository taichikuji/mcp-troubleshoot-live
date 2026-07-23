# syntax=docker/dockerfile:1

# Stage 1: compile TypeScript and prune dev dependencies.
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# Cache mount: npm registry tarballs survive across builds.
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && \
    npm prune --omit=dev

# Stage 2: minimal runtime image. Archive extraction is implemented in Node.
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# --chown at COPY avoids a separate `chown -R` layer that duplicates node_modules.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist          ./dist
COPY --chown=node:node package.json ./

# Mountpoint must exist so the container starts cleanly when no host mount is given.
RUN mkdir -p /bundles && chown node:node /bundles

USER node

EXPOSE 3000

# Pure-Node health check so we don't need curl in the runtime image.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
