# syntax=docker/dockerfile:1.7

FROM node:24-slim AS cli

ARG GEMINI_CLI_VERSION=0.40.1
ARG CODEX_CLI_VERSION=0.125.0

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.npm \
    npm install -g "@google/gemini-cli@${GEMINI_CLI_VERSION}" "@openai/codex@${CODEX_CLI_VERSION}" && \
    (curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin || test -x /usr/local/bin/agy) && \
    npm cache clean --force && \
    find /usr/local/lib/node_modules/@google /usr/local/lib/node_modules/@openai -type f -name "*.map" -delete && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

FROM node:24-slim AS build

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      g++ \
      make \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --omit=dev && \
    rm -rf node_modules/node-pty/prebuilds

FROM node:24-slim AS runtime

WORKDIR /app

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      dbus-x11 \
      gnome-keyring \
      libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=cli /usr/local/lib/node_modules/@google /usr/local/lib/node_modules/@google
COPY --from=cli /usr/local/lib/node_modules/@openai /usr/local/lib/node_modules/@openai
COPY --from=cli /usr/local/bin/agy /usr/local/bin/agy
COPY --from=build /app/node_modules ./node_modules
RUN ln -sf /usr/local/lib/node_modules/@google/gemini-cli/bundle/gemini.js /usr/local/bin/gemini && \
    ln -sf /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

ENV GEMINI_BIN=/usr/local/bin/gemini \
    ANTIGRAVITY_BIN=/usr/local/bin/agy \
    CODEX_BIN=/usr/local/bin/codex \
    PORT=8080

COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN node --check src/server.js && \
    node --check src/session.js && \
    node --check src/session-manager.js && \
    node --check src/providers/base.js && \
    node --check src/providers/antigravity.js && \
    node --check src/providers/gemini.js && \
    node --check src/providers/openai-codex.js && \
    command -v agy >/dev/null 2>&1 && \
    command -v gemini >/dev/null 2>&1 && \
    command -v codex >/dev/null 2>&1 && \
    chmod +x docker-entrypoint.sh

USER node

EXPOSE 8080
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
