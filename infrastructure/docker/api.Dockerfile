# syntax=docker/dockerfile:1.7
# NestJS API + workers. One image, different commands per role (see compose files).
FROM node:20.20.2-bookworm-slim AS base
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- dependencies (cached layer) -------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/validation/package.json packages/validation/
COPY packages/platform-connectors/package.json packages/platform-connectors/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts

# ---- build ----------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/api apps/api
RUN npm run generate -w @clipforge/database \
 && npm run build -w @clipforge/shared-types \
 && npm run build -w @clipforge/validation \
 && npm run build -w @clipforge/platform-connectors \
 && npm run build -w @clipforge/database \
 && npm run build -w @clipforge/api

# ---- runtime --------------------------------------------------------------------
FROM base AS runtime
RUN groupadd --gid 10001 clipforge && useradd --uid 10001 --gid clipforge --create-home clipforge
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
COPY infrastructure/scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R clipforge:clipforge /app
USER clipforge
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
