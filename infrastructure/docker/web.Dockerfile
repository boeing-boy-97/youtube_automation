# syntax=docker/dockerfile:1.7
FROM node:20.20.2-bookworm-slim AS deps
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/database/package.json packages/database/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/validation/package.json packages/validation/
COPY packages/platform-connectors/package.json packages/platform-connectors/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts

FROM deps AS build
COPY apps/web apps/web
WORKDIR /app/apps/web
# API_INTERNAL_URL is baked into the rewrite rules at build time; the browser never sees it.
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
RUN npm run build

FROM node:20.20.2-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN groupadd --gid 10002 clipforge && useradd --uid 10002 --gid clipforge --create-home clipforge
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/package-lock.json ./package-lock.json
USER clipforge
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/web
CMD ["npm", "run", "start"]
