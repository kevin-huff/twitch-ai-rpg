FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/rules/package.json packages/rules/package.json
COPY packages/test-fixtures/package.json packages/test-fixtures/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build
RUN npm prune --omit=dev

FROM node:24.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /app/.local/audio && chown -R node:node /app/.local
USER node
EXPOSE 3000
# Run node directly, not npm start: the stop signal Railway sends when it retires a deployment then reaches the
# server's own handler, which closes cleanly and exits 0. npm reports being stopped as a failure, which Railway
# emails as "Deploy Crashed!".
CMD ["node", "--env-file-if-exists=.env", "--import", "tsx", "apps/server/src/main.ts"]
