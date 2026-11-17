# The API (default) and the settlement worker, from one image.
#   docker build -t nummo .
#   docker run --env-file .env -p 8787:8787 nummo                       # API, checkout, portal, dashboard
#   docker run --env-file .env nummo node apps/worker/src/main.ts        # worker
# Node runs the TypeScript directly; there is no build step.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm store prune
USER node
EXPOSE 8787
CMD ["node", "apps/api/src/server.ts"]
