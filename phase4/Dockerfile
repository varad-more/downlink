# Pinned to multi-arch manifest-list digests, resolved 2026-09-03.
# Refresh with `make pin-base IMAGE=node:22-bookworm-slim` (and nginx below).
FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npx tsc -b && npx vite build

# Static serve. No CDN, no external font, no tile server: the whole kiosk is
# in this image and it will come up on a wall with no internet.
FROM nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
