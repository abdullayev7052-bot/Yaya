# 1) Web build of the collector app (same code as the APK) for the in-panel tester.
FROM node:22-slim AS webapp
WORKDIR /m
ENV CI=1 EXPO_NO_TELEMETRY=1
COPY mobile/package.json mobile/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY mobile ./
RUN npx expo export --platform web --output-dir /webapp

# 2) Server + admin panel.
FROM node:22-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY admin ./admin
COPY --from=webapp /webapp ./webapp
ENV NODE_ENV=production DB_FILE=/data/yaya.db WEBAPP_DIR=/app/webapp
WORKDIR /app/server
CMD ["node", "src/index.js"]
