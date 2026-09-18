FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# prisma.config.ts requires DATABASE_URL even for `prisma generate`, which never connects:
# use a throwaway placeholder for this step only (the real URL is provided at runtime).
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate && npx nest build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts /app/tsconfig.json ./
EXPOSE 3000
USER node
# exec: node becomes PID 1's replacement so it receives SIGTERM directly for a graceful shutdown.
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed && exec node dist/main.js"]
