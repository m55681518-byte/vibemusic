# VibeMusic — PWA Audio Extractor & Player

Extract the audio from any link (TikTok, YouTube, Instagram, SoundCloud, Twitter/X, Vimeo and
hundreds more via yt-dlp), get a **tagged MP3 with embedded cover art**, play it with
**synced scrolling lyrics**, and download the file straight to your device's Downloads folder.

## Features

- **PWA** — installable (manifest + icons + service worker), install prompt, standalone display.
- **Android Web Share Target** — share any video URL from another app and VibeMusic opens
  `/share` with the URL already filled in.
- **Extraction done server-side** — API route shells out to `yt-dlp` to pull an audio-only
  stream, converts to MP3, and embeds the video thumbnail into the ID3 tags (`--embed-thumbnail`).
- **Client-side ID3 parsing** — the player reads the MP3's ID3 tags with `jsmediatags` to render
  the embedded cover art and correct title/artist regardless of what the metadata reported.
- **Lyrics** — title + artist are queried against [LRCLIB](https://lrclib.net) (live-synced LRC
  or plain lyrics) through a server proxy route; synced lines auto-scroll with the audio.
- **One-tap download** — the fetched audio blob becomes a Blob URL and a hidden `<a download>`
  click saves `Artist - Title.mp3` into the native Downloads folder.
- **Range requests** — the audio route supports HTTP `Range`, so seeking works.
- **Birthday-simple deployment** — single `next build`, runs on Vercel, Netlify or a Node host
  that can spawn `yt-dlp` + `ffmpeg`.

## Architecture

```
src/
  app/
    page.tsx                Home: paste-a-link extract form
    manifest.ts             PWA manifest incl. share_target (GET /share)
    share/page.tsx          Web Share Target landing → redirects to /extract?url=…
    extract/page.tsx        Running state for POST /api/extract → /player/[id]
    player/[id]/page.tsx    Server-rendered player shell (loads meta)
    api/
      extract/route.ts      POST { url } → runs yt-dlp, tags MP3, returns meta
      audio/[id]/route.ts   Streams the MP3 (Range/206 support, Download header)
      meta/[id]/route.ts    Track metadata JSON
      lyrics/route.ts       LRCLIB proxy (s-maxage caching)
  components/
    PlayerView.tsx          Fetches blob → jsmediatags → cover art → lyrics → <a download>
    LyricsView.tsx          Scrolling synced lyrics (scales with currentTime)
    ExtractForm.tsx         URL input
    InstallPwa.tsx          beforeinstallprompt banner
    SwRegister.tsx          registers /sw.js
    Logo.tsx, ShareTargetHint.tsx
  lib/
    extract.ts              Extraction orchestration (single-flight per URL, ffmpeg fallback)
    ytdlp.ts                yt-dlp binary resolution + wrapper
    store.ts                storage dir + meta persistence + pruning
    lyrics.ts               LRCLIB lookup (exact → search)
    utils.ts                LRC parsing, filenames, base64
public/
  sw.js                     Precaches shell; network-first nav; never touches /api/*
  icons/…                   Generated PNG icons (scripts/gen-icons.mjs)
vendor/                     yt-dlp binary (auto-downloaded on postinstall, gitignored)
storage/                    Extracted MP3s + JSON meta (gitignored)
scripts/
  gen-icons.mjs             Pure-Node PNG icon generator (zlib, no deps)
  install-ytdlp.mjs         Downloads yt-dlp binary from GitHub on `npm install`
```

## Prerequisites

- **Node.js ≥ 18** (built against Node 24)
- **ffmpeg** on the server `PATH` for MP3 conversion + thumbnail embedding.
  Without it, extraction fails with a clear message (yt-dlp can still pull audio via plain
  download, but conversion to MP3 requires ffmpeg).
- **yt-dlp** — auto-downloaded to `vendor/` on `postinstall`; override with `YTDLP_PATH`.

## Quick start

```bash
npm install        # also downloads yt-dlp into vendor/
node scripts/gen-icons.mjs   # if icons are missing
npm run dev        # http://localhost:3000
```

Production build:

```bash
npm run build
```

## Environment variables

| Var                | Default                  | Purpose                          |
| ------------------ | ------------------------ | -------------------------------- |
| `YTDLP_PATH`       | auto (vendor/yt-dlp)     | Override the yt-dlp binary path  |
| `STORAGE_DIR`      | `<project>/storage`      | Where MP3s + meta are stored     |
| `LRCLIB_BASE_URL`  | `https://lrclib.net/api` | Lyrics API base                  |

See `.env.example`.

## Web Share Target flow (Android)

1. Chrome/Android reads `share_target` from the manifest.
2. User shares a video from TikTok → "VibeMusic" appears in the share sheet.
3. System opens `https://app.example/share?url=<encoded>&text=…&title=…`.
4. `/share` extracts the first `http(s)` URL and redirects to `/extract?url=…`.
5. Extraction runs, then redirects to `/player/<id>`.

## Deploy notes

- The extraction route calls out to `yt-dlp`/`ffmpeg` subprocesses, so it needs a **Node
  server runtime** (not edge). Works out of the box on Vercel/Netlify and any Node host.
- `maxDuration = 300` is set on the extract route — raise serverless function timeouts
  (Vercel: Function Max Duration) so long looks (a few minutes) don't time out.
- On serverless, point `STORAGE_DIR` at a writable volume; ephemeral disk works but files
  are cleaned on redeploys. A mounted volume or object store keeps tracks across deploys.
- `yt-dlp` binary + ffmpeg must exist where the function runs; for Docker deploys bake them
  in. On Vercel, install ffmpeg via a build step, or run this on your own box.

## Notes

- Service worker intentionally ignores `/api/*` so audio+extraction are always fresh.
- Extraction is single-flight per URL; repeated requests for the same URL serve the cached
  MP3 until the 24h prune.