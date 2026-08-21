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
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates yt-dlp && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux && chmod +x /usr/local/bin/yt-dlp
ENV YTDLP_PATH=/usr/local/bin/yt-dlp
# Verbose yt-dlp stderr on failures (plugin/POT diagnostics surface in the
# extract error details). Set to 0 to silence.
ENV YTDLP_DEBUG=1
# bgutil POT provider: prebuilt server image (port 4416) + yt-dlp plugin so
# YouTube datacenter-IP requests carry PO tokens.
COPY --from=brainicism/bgutil-ytdlp-pot-provider:latest /app /opt/pot
RUN curl -fsSL https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/heads/master.tar.gz -o /tmp/bgutil.tar.gz \
 && mkdir -p /tmp/bgutil /etc/yt-dlp/plugins /root/.config/yt-dlp/plugins \
 && tar xzf /tmp/bgutil.tar.gz -C /tmp/bgutil --strip-components=1 \
 && cp -r /tmp/bgutil/plugin /etc/yt-dlp/plugins/bgutil \
 && cp -r /tmp/bgutil/plugin /root/.config/yt-dlp/plugins/bgutil \
 && rm -rf /tmp/bgutil /tmp/bgutil.tar.gz
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