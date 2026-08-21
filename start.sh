#!/bin/sh
# POT provider server (port 4416) for yt-dlp YouTube PO tokens, then Next.js.
node /opt/bgutil-ytdlp-pot-provider/server/build/main.js &
exec node_modules/.bin/next start
