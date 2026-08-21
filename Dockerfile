FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates yt-dlp git && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x /usr/local/bin/yt-dlp
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
# bgutil POT provider: server (port 4416) + yt-dlp plugin so YouTube datacenter-IP
# requests carry PO tokens ("Sign in to confirm you're not a bot" fix).
RUN git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil-ytdlp-pot-provider \
 && cd /opt/bgutil-ytdlp-pot-provider/server \
 && npm ci --no-audit --no-fund \
 && npx tsc \
 && mkdir -p /etc/yt-dlp/plugins \
 && cp -r /opt/bgutil-ytdlp-pot-provider/plugin /etc/yt-dlp/plugins/bgutil
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY public ./public
COPY start.sh ./start.sh
RUN chmod +x start.sh
RUN mkdir -p /storage
VOLUME ["/storage"]
ENV STORAGE_DIR=/storage
EXPOSE 3000
CMD ["./start.sh"]
