# Production image: built app and API on one port. Data lives in /app/data (mount a volume there).
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 CADENCE_REQUIRE_LOGIN=1
EXPOSE 8080
CMD ["./node_modules/.bin/tsx", "server/main.ts"]
