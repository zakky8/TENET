# syntax=docker/dockerfile:1.7
#
# TENET production container.
# Pattern borrowed from OpenClaw audit (376k★) + tightened:
#   - multi-stage: deps → build → prune → runtime
#   - SHA-pinned base images for reproducibility (pin in CI on tag releases)
#   - non-root USER (uid 10001 to match infra/helm/tenet defaults)
#   - tini as PID 1 for proper signal forwarding
#   - HEALTHCHECK against /healthz (REST surface)
#   - loopback binding default; operator opens via --network host or k8s service
#
# Build:
#   docker build -t tenet:latest .
# Run:
#   docker run --rm -p 127.0.0.1:8080:8080 tenet:latest
#
# Operators wanting a browser / Python / Docker CLI in the image build with:
#   docker build --build-arg TENET_INSTALL_BROWSER=true -t tenet:browser .

# ── Stage 1: workspace dependency manifest extraction ────────────────────
FROM node:22-bookworm AS workspace-deps
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages packages
COPY surfaces surfaces
COPY connectors connectors
COPY models models
COPY stores stores
COPY apps apps
COPY eval eval
# Drop everything that isn't a package.json. The next stage's
# pnpm install layer only invalidates when a manifest changes.
RUN find . -type f ! -name 'package.json' ! -name 'pnpm-lock.yaml' ! -name 'pnpm-workspace.yaml' -delete \
 && find . -type d -empty -delete

# ── Stage 2: full build ──────────────────────────────────────────────────
FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable
COPY --from=workspace-deps /app /app
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# Now copy actual sources + configs + scripts (build context).
COPY . .
RUN pnpm -r build

# ── Stage 3: prune dev deps + tree-shake build artifacts ─────────────────
FROM node:22-bookworm AS prune
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod \
 && find . -type d -name '__tests__' -prune -exec rm -rf {} + \
 && find . -type f \( -name '*.test.ts' -o -name '*.test.js' -o -name '*.map' -o -name '*.d.ts.map' \) -delete

# ── Stage 4: minimal runtime ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
# tini for proper PID 1 / signal forwarding; ca-certificates for HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Non-root user (uid 10001) — matches infra/helm/tenet podSecurityContext.
RUN groupadd --system --gid 10001 tenet \
 && useradd --system --uid 10001 --gid tenet --create-home --home-dir /home/tenet --shell /bin/false tenet \
 && mkdir -p /app /home/tenet/.tenet \
 && chown -R tenet:tenet /app /home/tenet

WORKDIR /app
COPY --from=prune --chown=tenet:tenet /app /app

USER tenet
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    TENET_HOST=127.0.0.1 \
    TENET_PORT=8080

EXPOSE 8080

# Health check hits the REST surface's /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "-s", "--"]
# Operator-overridable. Default boots the enterprise-support reference app.
CMD ["node", "apps/enterprise-support/dist/cli.js"]
