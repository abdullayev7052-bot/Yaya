FROM node:22-slim
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
COPY admin ./admin
ENV NODE_ENV=production DB_FILE=/data/yaya.db
WORKDIR /app/server
CMD ["node", "src/index.js"]
