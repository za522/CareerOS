FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 CAREEROS_DATA_DIR=/var/lib/careeros CAREEROS_CHROME_PATH=/usr/bin/chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium poppler-utils \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/packages/ai/package.json ./packages/ai/package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
RUN corepack pnpm install --prod --frozen-lockfile
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/ai/dist ./packages/ai/dist
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
RUN mkdir -p /var/lib/careeros && chown -R node:node /app /var/lib/careeros
USER node
EXPOSE 4310
CMD ["node", "apps/api/dist/server.js"]
