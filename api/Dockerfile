FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile 2>/dev/null || yarn install
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
RUN mkdir -p /uploads
EXPOSE 4001
CMD ["node", "dist/index.js"]
