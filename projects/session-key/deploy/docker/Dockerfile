FROM node:20-alpine AS builder

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/evm/package.json packages/evm/
COPY packages/server/package.json packages/server/

RUN npm install -g pnpm && pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/evm/ packages/evm/
COPY packages/server/ packages/server/

RUN pnpm --filter @sftgroup/session-key-core build && \
    pnpm --filter @sftgroup/session-key-evm build && \
    pnpm --filter @sftgroup/session-key-server build

FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/packages/server/dist /app/dist
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages/core/dist /app/node_modules/@sftgroup/session-key-core/dist
COPY --from=builder /app/packages/evm/dist /app/node_modules/@sftgroup/session-key-evm/dist
COPY deploy/migrations /app/deploy/migrations

ENV NODE_ENV=production
EXPOSE 3500

CMD ["node", "dist/index.js"]
