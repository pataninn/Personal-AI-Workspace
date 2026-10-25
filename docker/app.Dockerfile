FROM node:22.23.4-bookworm-slim AS build

ENV COREPACK_HOME=/tmp/corepack
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/markitdown && /opt/markitdown/bin/pip install --no-cache-dir 'markitdown[pdf,docx,pptx,xlsx,xls]==0.1.8'

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile

COPY backend backend
COPY frontend frontend
RUN pnpm --filter personal-ai-workspace-backend build
RUN pnpm --filter personal-ai-workspace-frontend build

FROM node:22.23.4-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 pai && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin pai
# Fresh recovery volumes inherit a writable, private directory for the app user.
RUN mkdir -p /var/lib/personal-ai/recovery && chown 10001:10001 /var/lib/personal-ai/recovery && chmod 700 /var/lib/personal-ai/recovery
COPY --from=build --chown=10001:10001 /app/backend/dist backend/dist
COPY --from=build --chown=10001:10001 /app/frontend/dist frontend/dist
COPY --from=build --chown=10001:10001 /app/node_modules node_modules
COPY --from=build --chown=10001:10001 /app/backend/node_modules backend/node_modules
COPY --from=build --chown=10001:10001 /app/backend/package.json backend/package.json
COPY --from=build --chown=10001:10001 /opt/markitdown /opt/markitdown

USER 10001:10001
EXPOSE 8443

CMD ["node", "backend/dist/server.js"]
