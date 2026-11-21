FROM oven/bun:1.3-alpine

WORKDIR /app

# Copy workspace structure
COPY package.json ./
COPY scripts/postinstall.cjs ./scripts/postinstall.cjs
COPY packages/cli/package.json ./packages/cli/package.json

# Copy source
COPY packages/cli/src ./packages/cli/src
COPY packages/cli/bin ./packages/cli/bin
COPY packages/cli/tsconfig.json ./packages/cli/tsconfig.json
COPY packages/cli/scripts ./packages/cli/scripts

# Install deps (skip lockfile — partial workspace)
RUN bun install --production --no-save

# #1140 — the git revision this image is built from (compose build.args feeds
# it from `git rev-parse HEAD`; "unknown" outside the docker path). Placed here
# so an arg change busts only this RUN's cache onward, not bun install above.
ARG CLAUDISH_REVISION=unknown

# Generate version file (bakes VERSION + REVISION into src/version.ts)
RUN bun run packages/cli/scripts/generate-version.ts 2>/dev/null || true

# Expose proxy port
EXPOSE 3000

# Config directory
VOLUME /root/.claudish

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://0.0.0.0:3000/health || exit 1

ENTRYPOINT ["bun", "run", "packages/cli/src/fork/server/standalone-proxy.ts"]
CMD ["--port", "3000"]
