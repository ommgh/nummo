# The API (default) and the settlement worker, from one image.
#   docker build -t nummo .
#   docker run --env-file .env -p 8787:8787 nummo                       # API, website, dashboard, checkout, portal
#   docker run --env-file .env nummo node apps/worker/src/main.ts        # worker
# Node runs the TypeScript directly. The only build step is the website and dashboard (apps/web, Vite).
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @usenummo/web build && pnpm store prune
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "apps/api/src/server.ts"]
