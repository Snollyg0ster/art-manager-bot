# Один образ на бота, воркеры и миграции: процесс выбирается командой в
# docker-compose.yml. Сборки нет — как и локально, код запускает tsx, поэтому
# dev-зависимости (tsx, drizzle-kit) нужны и в рантайме.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force

COPY . .

ENV NODE_ENV=production
USER node

CMD ["node_modules/.bin/tsx", "src/index.ts"]
