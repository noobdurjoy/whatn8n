# Dashboard + backend (Next.js standalone build).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN useradd --system --uid 1001 app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# Migration, seed and staff scripts (run with `docker compose run --rm app node scripts/...`).
# Their dependencies (pg, @node-rs/argon2) are already in the traced standalone node_modules.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/db ./db
COPY --from=build /app/prompts ./prompts
USER app
EXPOSE 3000
CMD ["node", "server.js"]
