FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . ./
RUN npm run build && npm prune --production

VOLUME ["/app/files"]
EXPOSE 8080
ENV NODE_ENV=production
CMD ["node", "server.js"]
