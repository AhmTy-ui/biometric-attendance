# BAMP platform image: builds the React dashboard and the Node.js backend, serves both from one container.
# Build:  docker build -t bamp/platform:1.0.0 .

FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS backend
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY backend/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
RUN apk add --no-cache postgresql16-client tini ca-certificates \
 && addgroup -S bamp && adduser -S bamp -G bamp
WORKDIR /app/backend
ENV NODE_ENV=production \
    FRONTEND_DIST=/app/frontend/dist \
    PG_DUMP_PATH=/usr/bin/pg_dump
COPY --from=backend /app/backend/node_modules ./node_modules
COPY --from=backend /app/backend/dist ./dist
COPY --from=backend /app/backend/package.json ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist
USER bamp
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
