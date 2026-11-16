# 2026 HBD 派對遊戲平台 — multi-stage（builder: node:26-alpine + npm ci；runtime: 只帶 dist + production node_modules）
FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.client.json ./
COPY src ./src
COPY public ./public
COPY seed ./seed
RUN npm run build:tsc && npm prune --omit=dev

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    MEDIA_DIR=/app/media
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/seed ./seed
COPY scripts ./scripts
COPY package.json ./
RUN mkdir -p /app/data /app/media && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/api/ready || exit 1
CMD ["node", "dist/server/index.js"]
