# VERIFY: pin to a digest before deployment -- CHECK: make pin-base
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npx tsc -b && npx vite build

# Static serve. No CDN, no external font, no tile server: the whole kiosk is
# in this image and it will come up on a wall with no internet.
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
