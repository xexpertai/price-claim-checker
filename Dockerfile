# Price-Claim Checker on Cloud Run: RECORDED mode only (replays real SerpApi responses in fixtures/recorded).
# No API key is ever put in the image or the service, so the hosted demo cannot spend SerpApi credits.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 PCC_MODE=recorded PCC_DATA_DIR=/tmp/pcc
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY fixtures/recorded ./fixtures/recorded
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server.ts"]
