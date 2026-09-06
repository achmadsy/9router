# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# CN mirror for apk (used by builder and runner stages)
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

FROM base AS builder

RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package*.json ./
RUN npm install --registry=https://registry.npmmirror.com

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
# ZCode and OAuth executors import from src/lib at runtime outside Next.js bundling.
COPY --from=builder /app/src/lib/zcode ./src/lib/zcode
COPY --from=builder /app/src/lib/oauth ./src/lib/oauth
COPY --from=builder /app/src/lib/sentry.js ./src/lib/sentry.js
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
RUN apk --no-cache upgrade && apk --no-cache add su-exec x11vnc novnc websockify && \
  test -f /usr/share/novnc/vnc.html && \
  printf '#!/bin/sh\nchown -R node:node /app/data /app/data-home 2>/dev/null\nexport DISPLAY="${DISPLAY:-:99}"\nif ! pgrep -x Xvfb >/dev/null 2>&1; then\n  Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -ac &\nfi\nif [ "${NOVNC_ENABLED:-false}" = "true" ]; then\n  attempts=0\n  until su-exec node x11vnc -noshm -display "$DISPLAY" -localhost -rfbport 5900 -nopw -forever -shared -bg; do\n    attempts=$((attempts + 1))\n    if [ "$attempts" -ge 10 ]; then\n      printf "noVNC: failed to attach to X display; continuing without viewer\\n" >&2\n      break\n    fi\n    sleep 1\n  done\n  if [ "$attempts" -lt 10 ]; then\n    su-exec node websockify --web=/usr/share/novnc 6080 127.0.0.1:5900 &\n  fi\nfi\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "custom-server.js"]
