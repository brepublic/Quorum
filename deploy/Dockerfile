# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.test.json vite.config.ts ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/rule-schema/package.json packages/rule-schema/package.json
COPY server/package.json server/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY . .
ARG RELEASE_TAG=""
ARG RELEASE_COMMIT=""
RUN RELEASE_TAG="$RELEASE_TAG" GITHUB_SHA="$RELEASE_COMMIT" pnpm build:self-host

FROM node:22-bookworm-slim AS app-runtime
ARG RELEASE_TAG=""
ARG RELEASE_COMMIT=""
LABEL org.opencontainers.image.revision=$RELEASE_COMMIT io.quorum.release=$RELEASE_TAG io.quorum.upgrade-protocol="1"
ENV QUORUM_BUILD_VERSION=$RELEASE_TAG
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/packages ./packages
COPY --from=build /workspace/server/node_modules ./server/node_modules
COPY --from=build /workspace/server/package.json ./server/package.json
COPY --from=build /workspace/server/dist ./server/dist
COPY --from=build /workspace/server/migrations ./server/migrations
RUN mkdir -p /var/lib/quorum/files && chown -R node:node /var/lib/quorum
USER node
CMD ["node", "--enable-source-maps", "server/dist/index.js"]

FROM caddy:2.8-alpine AS caddy-runtime
ARG RELEASE_TAG=""
ARG RELEASE_COMMIT=""
LABEL org.opencontainers.image.revision=$RELEASE_COMMIT io.quorum.release=$RELEASE_TAG
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/build /srv
