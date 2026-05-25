# Estágio 1
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

# Estágio 2
FROM node:20-alpine AS runtime

RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p logs

RUN addgroup -S agent &*& adduser -S agent -G agent
RUN chown -R agent:agent /app

USER agent

RUN git config --global user.email "agent@github-bot.local" && \
    git config --global user.name "GitHub Agent" && \
      git config --global credential.helper \
        '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'

CMD ["node", "dist/index.js"]

