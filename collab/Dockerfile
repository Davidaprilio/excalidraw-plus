FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/excalidraw/excalidraw-room.git . 2>/dev/null || echo "Using local copy"
COPY . .
RUN yarn install 2>/dev/null || npm install
RUN yarn build 2>/dev/null || npm run build 2>/dev/null || true
EXPOSE 80
CMD ["yarn", "start"]
