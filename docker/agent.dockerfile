FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/erc8004-client/ packages/erc8004-client/
COPY packages/guardian/ packages/guardian/
COPY packages/x402-client/ packages/x402-client/
COPY apps/agent/ apps/agent/

RUN npm ci
RUN npx turbo build --filter=@panthers/agent...

FROM node:22-slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/core/package.json packages/core/package.json
COPY --from=builder /app/packages/erc8004-client/dist/ packages/erc8004-client/dist/
COPY --from=builder /app/packages/erc8004-client/package.json packages/erc8004-client/package.json
COPY --from=builder /app/packages/guardian/dist/ packages/guardian/dist/
COPY --from=builder /app/packages/guardian/package.json packages/guardian/package.json
COPY --from=builder /app/packages/x402-client/dist/ packages/x402-client/dist/
COPY --from=builder /app/packages/x402-client/package.json packages/x402-client/package.json
COPY --from=builder /app/apps/agent/dist/ apps/agent/dist/
COPY --from=builder /app/apps/agent/package.json apps/agent/package.json
COPY --from=builder /app/apps/agent/node_modules/ apps/agent/node_modules/
COPY --from=builder /app/package.json package.json

ENV NODE_ENV=production

RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "apps/agent/dist/index.js"]
