# Pinned to a multi-arch manifest-list digest, resolved 2026-09-03.
# Refresh with `make pin-base IMAGE=node:22-bookworm-slim`.
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
