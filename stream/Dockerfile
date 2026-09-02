# VERIFY: pin to a digest before deployment -- CHECK: make pin-base
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
