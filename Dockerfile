# Estágio 1 — compilação (Alpine é suficiente, só precisa de tsc)
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Estágio 2 — runtime (debian-slim para suportar o binário glibc do claude CLI)
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p logs

RUN chown -R node:node /app

USER node

RUN git config --global user.email "agent@github-bot.local" && \
    git config --global user.name "GitHub Agent" && \
    git config --global credential.helper \
      '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f' && \
    git config --global safe.directory /workspace/repo

CMD ["node", "dist/index.js"]
