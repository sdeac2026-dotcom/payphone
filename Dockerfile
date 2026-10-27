# syntax=docker/dockerfile:1
# =============================================================================
# PayPhone — production image (engine + oracle + web console, one container).
#
# Three build stages, one lean runtime:
#   1. rust:1-slim        → payphone-engine (static-ish release binary, rustls)
#   2. oven/bun:1         → Next.js standalone console (.next/standalone)
#   3. node:22-slim       → runtime: node (web) + python venv (oracle) + engine
#
# The ONLY public port is the web console on $PORT. The engine and the
# oracle bind loopback inside the container and are reached through the
# Next.js same-origin gateway (/api/v1/*) — one port, no internal mesh.
#
# Build:  docker build -t payphone .
# Run:    docker run -p 8080:8080 --env-file .env payphone
# =============================================================================

# ------------------------------------------------------------------ engine --
FROM rust:1-slim AS engine-build
WORKDIR /src/engine
COPY engine/ .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/engine/target \
    cargo build --release \
 && cp target/release/payphone-engine /usr/local/bin/payphone-engine

# ----------------------------------------------------------------- console --
FROM oven/bun:1 AS console-build
WORKDIR /app
COPY package.json bun.lock ./
COPY src ./src
COPY public ./public
COPY next.config.ts tsconfig.json postcss.config.mjs tailwind.config.ts components.json ./
RUN bun install --frozen-lockfile
# `bun run build` = next build + assemble .next/standalone (static + public)
RUN bun run build

# ----------------------------------------------------------------- runtime --
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Oracle dependencies in an isolated venv (requirements.txt is the source of truth)
COPY services/oracle-py/requirements.txt /tmp/oracle-requirements.txt
RUN python3 -m venv /opt/oracle-venv \
 && /opt/oracle-venv/bin/pip install --no-cache-dir -r /tmp/oracle-requirements.txt \
 && rm /tmp/oracle-requirements.txt

WORKDIR /opt/payphone
COPY --from=engine-build /usr/local/bin/payphone-engine bin/payphone-engine
COPY --from=console-build /app/.next/standalone web
COPY services/oracle-py oracle
COPY deploy/start.sh bin/start.sh
RUN chmod +x bin/payphone-engine bin/start.sh

# Sensible production defaults — secrets come from the platform env, never
# baked into the image. Engine + oracle are loopback-only; web is public.
ENV PAYPHONE_ENV=production \
    PAYPHONE_ENGINE_URL=http://127.0.0.1:8081 \
    PAYPHONE_PORT=8081 \
    PAYPHONE_ORACLE_URL=http://127.0.0.1:8001 \
    ORACLE_PORT=8001 \
    HOSTNAME=0.0.0.0 \
    NODE_ENV=production

# Railway/Render inject $PORT (Render defaults to 10000, Railway to 8080).
EXPOSE 3000 8080 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

CMD ["bash", "/opt/payphone/bin/start.sh"]
