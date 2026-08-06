# bookworm-slim rather than alpine: better-sqlite3 ships prebuilt binaries for glibc,
# so the image needs no compiler toolchain.
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Drop devDependencies from the tree that gets copied into the runtime image.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MRA_CONFIG=/app/config/config.yaml \
    MRA_DATA_DIR=/app/data \
    LOG_FORMAT=json

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The data directory holds the SQLite database and must outlive the container.
RUN mkdir -p /app/data /app/config && chown -R node:node /app

USER node
VOLUME ["/app/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Runs the scheduler and the admin panel. Override with `run --once` to use the image
# as a one-shot job under host cron, a systemd timer, or a Kubernetes CronJob.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve"]
