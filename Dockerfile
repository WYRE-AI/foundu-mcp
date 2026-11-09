# node:22-alpine, pinned by manifest-list digest. Bump deliberately.
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS production

RUN apk -U upgrade --no-cache \
  && addgroup -g 1001 -S foundu \
  && adduser -S foundu -u 1001 -G foundu

WORKDIR /app

COPY --from=builder --chown=foundu:foundu /app/package.json ./
COPY --from=builder --chown=foundu:foundu /app/dist ./dist
COPY --from=builder --chown=foundu:foundu /app/node_modules ./node_modules

# npm/npx are not needed at runtime and carry their own CVE surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER foundu

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# 0.0.0.0 is safe only because startup refuses to listen without a real
# CONDUIT_S2S_SECRET, which is supplied at runtime by the platform and never
# baked into the image. AUTH_MODE=gateway never falls back to env credentials;
# a short-lived access token arrives per request on X-FoundU-Access-Token and
# the gateway owns refresh. Only the read tier is enabled; the admin tier
# (per-employee pay-figure reports) needs FOUNDU_TOOL_TIERS=read,admin.
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    MCP_TRANSPORT=http \
    MCP_HTTP_PORT=8080 \
    MCP_HTTP_HOST=0.0.0.0 \
    AUTH_MODE=gateway \
    FOUNDU_TOOL_TIERS=read

CMD ["node", "dist/http.js"]

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/foundu-mcp"
LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL description="foundU MCP Server - read-only Model Context Protocol server for the foundU workforce API"
LABEL org.opencontainers.image.title="foundu-mcp"
LABEL org.opencontainers.image.description="Read-only Model Context Protocol server for the foundU workforce API"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/foundu-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/WYRE-AI/foundu-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/WYRE-AI/foundu-mcp/pkgs/container/foundu-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"
