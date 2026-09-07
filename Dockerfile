FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/data STATIC_DIR=/app/dist/client
WORKDIR /app
COPY --from=build /app/dist/client ./dist/client
COPY server ./server
COPY lib/blackjack-stats.ts ./lib/blackjack-stats.ts
COPY scripts/backup.mjs ./scripts/backup.mjs
COPY scripts/grant-admin.ts ./scripts/grant-admin.ts
COPY package.json ./package.json
RUN mkdir /data /app/backups && chown node:node /data /app/backups
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.ts"]
