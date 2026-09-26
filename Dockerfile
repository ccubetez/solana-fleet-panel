FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

EXPOSE 3777
ENV CLUSTER=mainnet

CMD ["node", "server.mjs"]
