# Concept 49 — a container image for ci-kit/worker.mjs (an Agent SDK service).
# Build from the project root:   docker build -f ci-kit/Dockerfile -t agent-worker .
# Run:                           docker run --rm -p 8080:8080 -e ANTHROPIC_API_KEY agent-worker
#
# The SDK starts the native Claude Code binary, which npm installs as an optional platform package
# (@anthropic-ai/claude-agent-sdk-linux-x64 here). So `npm ci` must run INSIDE the image, for the image's
# OS/CPU — never copy a node_modules folder built on Windows or macOS into it.
FROM node:22-bookworm-slim

# git: Claude Code uses it for repo context; ca-certificates: TLS to api.anthropic.com; tini: a tiny init (PID 1)
# that forwards SIGTERM to node, so the graceful shutdown in worker.mjs actually runs.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY ci-kit/worker.mjs ./worker.mjs

# DRAIN_MS=20000 below: 20 s of drain + a few seconds of abort teardown must fit in the platform's grace period
# (Kubernetes' default terminationGracePeriodSeconds is 30 s).
# Never run an agent that has Bash as root. HOME and the Claude Code state go to a writable, throw-away place,
# so the root filesystem can be mounted read-only (docker run --read-only --tmpfs /tmp).
RUN useradd --create-home --uid 10001 agent && mkdir -p /work && chown agent /work
USER agent
ENV NODE_ENV=production \
    PORT=8080 \
    WORK_DIR=/work \
    CLAUDE_CONFIG_DIR=/tmp/claude \
    MAX_CONCURRENCY=2 \
    DRAIN_MS=20000 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# ANTHROPIC_API_KEY is NOT baked into the image: inject it at run time from the platform's secret store.

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "worker.mjs"]
