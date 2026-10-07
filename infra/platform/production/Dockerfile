# Build from the workspace root. No models, browser binaries or credentials are copied.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tooling
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --global pnpm@11.13.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/platform-contracts/package.json packages/platform-contracts/package.json
COPY packages/ai-core/package.json packages/ai-core/package.json
COPY packages/career-core/package.json packages/career-core/package.json
COPY services/platform-api/package.json services/platform-api/package.json
COPY apps/web/package.json apps/web/package.json

FROM tooling AS web-build
ARG VITE_PLATFORM_API_ORIGIN
ENV VITE_PLATFORM_API_ORIGIN=${VITE_PLATFORM_API_ORIGIN}
RUN pnpm --filter @companion/web... install --frozen-lockfile --ignore-scripts
COPY packages/platform-contracts/ packages/platform-contracts/
COPY apps/web/ apps/web/
RUN pnpm --filter @companion/web build

FROM tooling AS runtime-deps
RUN pnpm --filter @companion/platform-api... install --prod --frozen-lockfile --ignore-scripts

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PLATFORM_STORAGE_DIR=/app/.runtime
WORKDIR /app
COPY --from=runtime-deps /app/node_modules/ node_modules/
COPY --from=runtime-deps /app/packages/platform-contracts/ packages/platform-contracts/
COPY --from=runtime-deps /app/packages/ai-core/ packages/ai-core/
COPY --from=runtime-deps /app/packages/career-core/ packages/career-core/
COPY --from=runtime-deps /app/services/platform-api/ services/platform-api/
COPY package.json ./
COPY packages/platform-contracts/src/ packages/platform-contracts/src/
COPY packages/ai-core/src/ packages/ai-core/src/
COPY packages/career-core/src/ packages/career-core/src/
COPY services/platform-api/src/ services/platform-api/src/
COPY services/platform-api/migrations/ services/platform-api/migrations/
COPY --from=web-build /app/apps/web/dist/ apps/web/dist/
COPY infra/platform/production/entrypoint.sh infra/platform/production/entrypoint.sh
RUN chmod 0555 /app/infra/platform/production/entrypoint.sh && mkdir -p /app/.runtime && chown node:node /app/.runtime && chmod 0700 /app/.runtime
USER node
WORKDIR /app/services/platform-api
EXPOSE 4320
CMD ["/app/infra/platform/production/entrypoint.sh", "web"]
