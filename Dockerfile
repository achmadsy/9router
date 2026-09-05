# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS builder

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
ENV CLOAKBROWSER_BINARY_PATH=/usr/bin/chromium-browser
ENV CLOAKBROWSER_SUPPRESS_FONT_WARNING=1

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/custom-server.js ./custom-server.js
COPY --from=builder /app/open-sse ./open-sse
# Next file tracing can omit sibling files; MITM runs server.js as a separate process.
COPY --from=builder /app/src/mitm ./src/mitm
# Standalone node_modules may omit deps only required by the MITM child process.
COPY --from=builder /app/node_modules/node-forge ./node_modules/node-forge
# Ensure `next` is available at runtime in case tracing did not include it.
COPY --from=builder /app/node_modules/next ./node_modules/next
# Ensure `@sentry/node` is available for custom-server.js early error tracking.
COPY --from=builder /app/node_modules/@sentry ./node_modules/@sentry
# sql.js loads dist/sql-wasm.wasm by path at runtime; tracing only follows JS imports,
# so the last-resort DB driver would abort with ENOENT on the missing binary.
COPY --from=builder /app/node_modules/sql.js ./node_modules/sql.js
# node-machine-id is createRequire-loaded at runtime; tracing omits it.
COPY --from=builder /app/node_modules/node-machine-id ./node_modules/node-machine-id
# Cloakbrowser and playwright-core for headless captcha solving
COPY --from=builder /app/node_modules/cloakbrowser ./node_modules/cloakbrowser
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core

# Install chromium, xvfb, and required font/render dependencies for browser captcha solving
RUN apk --no-cache add chromium xvfb nss freetype harfbuzz ca-certificates ttf-freefont

RUN mkdir -p /app/data && chown -R node:node /app && \
  mkdir -p /app/data-home && chown node:node /app/data-home && \
  mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && \
  ln -sf /app/data-home /root/.9router 2>/dev/null || true

# Fix permissions at runtime (handles mounted volumes) and launch Xvfb virtual display
RUN apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexport DISPLAY="${DISPLAY:-:99}"\nif ! pgrep -x Xvfb >/dev/null 2>&1; then\n  Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac >/dev/null 2>&1 &\nfi\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
