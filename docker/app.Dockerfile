FROM node:22.20.0-bookworm-slim AS build

ENV COREPACK_HOME=/tmp/corepack
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile

COPY backend backend
COPY frontend frontend
RUN pnpm --filter personal-ai-workspace-backend build
RUN pnpm --filter personal-ai-workspace-frontend build

FROM node:22.20.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --gid 10001 pai && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin pai
COPY --from=build --chown=10001:10001 /app/backend/dist backend/dist
COPY --from=build --chown=10001:10001 /app/frontend/dist frontend/dist
COPY --from=build --chown=10001:10001 /app/node_modules node_modules
COPY --from=build --chown=10001:10001 /app/backend/node_modules backend/node_modules
COPY --from=build --chown=10001:10001 /app/backend/package.json backend/package.json

USER 10001:10001
EXPOSE 8443

CMD ["node", "backend/dist/server.js"]
