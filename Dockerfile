# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-bookworm
FROM ${NODE_IMAGE} AS base
WORKDIR /app

# Use Aliyun Debian mirrors (faster in CN; harmless elsewhere)
# Original URIs already carry /debian and /debian-security path suffixes.
RUN sed -i \
    -e 's|deb.debian.org|mirrors.aliyun.com|g' \
    -e 's|security.debian.org|mirrors.aliyun.com|g' \
    /etc/apt/sources.list.d/debian.sources

FROM base AS builder

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --registry=https://registry.npmmirror.com

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

# Use Aliyun Debian mirrors again on the runner stage
RUN sed -i \
    -e 's|deb.debian.org|mirrors.aliyun.com|g' \
    -e 's|security.debian.org|mirrors.aliyun.com|g' \
    /etc/apt/sources.list.d/debian.sources

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# custom-server.js early-requires @sentry/node; tracing often omits the full package.
COPY --from=builder /app/node_modules/@sentry ./node_modules/@sentry
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
# cloakbrowser is required dynamically by src/lib/zcode/browser.js; tracing can miss it.
# Its peer deps (playwright-core / socks-proxy-agent) must ship with it.
COPY --from=builder /app/node_modules/cloakbrowser ./node_modules/cloakbrowser
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=builder /app/node_modules/socks-proxy-agent ./node_modules/socks-proxy-agent

RUN mkdir -p /app/data /app/data-home && \
  chown node:node /app/data /app/data-home && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true && \
  # cloakbrowser downloads Chromium into $HOME/.cloakbrowser at first launch
  mkdir -p /home/node/.cloakbrowser && chown -R node:node /home/node && \
  chmod 755 /home/node /home/node/.cloakbrowser

# gosu: drop to node user after fixing volume perms (handles mounted volumes)
# Chromium runtime deps for cloakbrowser (captcha). Covers headless + headed fallback.
RUN apt-get update && apt-get install -y \
    gosu \
    ca-certificates \
    dbus \
    fonts-liberation \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcairo-gobject2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexec gosu node "$@"\n' > /entrypoint.sh \
    && chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
