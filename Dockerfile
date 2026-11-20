# syntax=docker/dockerfile:1

# ---- builder: compile native deps (better-sqlite3) -------------------------
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    UPLOADS_DIR=/app/uploads
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json config.json server.js db.js espn.js ./
COPY public ./public
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app/data /app/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
