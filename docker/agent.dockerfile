FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/idiostasis-core/ packages/idiostasis-core/
COPY apps/agent/ apps/agent/

RUN npm ci
RUN npx turbo build --filter=@panthers/agent...

FROM node:22-slim

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/idiostasis-core/dist/ packages/idiostasis-core/dist/
COPY --from=builder /app/packages/idiostasis-core/package.json packages/idiostasis-core/package.json
COPY --from=builder /app/apps/agent/dist/ apps/agent/dist/
COPY --from=builder /app/apps/agent/package.json apps/agent/package.json
COPY --from=builder /app/apps/agent/node_modules/ apps/agent/node_modules/
COPY --from=builder /app/package.json package.json

ENV NODE_ENV=production

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "apps/agent/dist/index.js"]
