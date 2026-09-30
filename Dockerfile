# Schatzsuche am Chrischtchindlimärit - Node ohne Abhängigkeiten.
FROM node:24.21.0-alpine

WORKDIR /app
COPY package.json ./
COPY config ./config
COPY src ./src
COPY public ./public

RUN mkdir /data && chown node:node /data

ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/config.json
VOLUME /data
EXPOSE 3000

USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O - http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/server.js"]
