# Deploying VibeMusic (Render / Railway)

VibeMusic needs a real Linux server at runtime: the `/api/extract` route shells out to
`yt-dlp` and `ffmpeg`, and writes extracted MP3s to `STORAGE_DIR`. The repo ships:

- **`Dockerfile`** — multi-stage build: deps (`npm ci --ignore-scripts`), build
  (`next build` + `prune --omit=dev`), runner (`node:20-slim`, apt `ffmpeg` + `curl`,
  standalone `yt-dlp_linux` at `/usr/local/bin/yt-dlp`, `/storage` volume,
  `STORAGE_DIR=/storage`, `CMD next start`).
- **`render.yaml`** / **`railway.json`** — platform blueprints (see below).
- **`.dockerignore`** + **`.github/workflows/verify-deploy.yml`** — CI builds the image
  and smoke-tests it on every push (`yt-dlp --version`, `ffmpeg -version`, `/` and
  manifest return 200).

## 0. Get the code onto GitHub

The repo is local (`C:\Users\Mike-\Documents\vibemusic`, git branch `main`). Push it to
GitHub so the cloud platform can pull it:

```bash
cd C:\Users\Mike-\Documents\vibemusic

# create an empty public/private repo, e.g. via gh (auth already on this machine)
gh repo create vibemusic --private --source=. --remote=origin --push
# ...or manually: create repo on github.com, then:
# git remote add origin https://github.com/<you>/vibemusic.git
# git push -u origin main
```

Watch **Actions → verify-deploy** on GitHub: the container smoke (real `docker build` +
`yt-dlp`/`ffmpeg` + HTTP 200) is the final proof the image is deployable.

## 2. Option A — Render (recommended: blueprint is committed)

1. Sign in at https://render.com and go to **New → Blueprint**.
2. Choose your `vibemusic` repo. Render reads `render.yaml` (web service, Docker
   runtime, plan `starter`, health check `/`, 1 GB disk mounted at `/storage`).
3. Hit **Apply**. Render builds the Docker image and starts the service.
4. Done: Render gives you `https://vibemusic-XXXX.onrender.com` (HTTPS, auto-renewed).
   Auto-deploys on every push to `main`.

> The blueprint pins `plan: starter` because **persistent disks don't exist on Render's
> free plan** and free services sleep after 15 min idle. Starter is ~$7/mo. If you prefer
> free: drop the `disk:` block and set `plan: free` — extractions still work, but stored
> files are lost whenever the instance restarts, and the service sleeps when idle.

## 3. Option B — Railway (blueprint is committed)

1. Sign in at https://railway.app, **New Project → Deploy from GitHub repo** → pick
   `vibemusic`. Railway auto-detects `railway.json` → **Dockerfile**.
2. In the service **Variables** tab add `STORAGE_DIR=/storage`. Add a **Volume** mounted
   at `/storage` (1 GB) if you want MP3s to survive restarts.
3. Railway builds the image and serves HTTPS at `https://<project>.up.railway.app`.

> Railway has no free tier (trial credits only); it's ~$5/mo + volume cost. The
> `railway.json` sets the start command, health check `/`, and restart policy.

## 4. Verify the deployment

- Open your URL — the home page + install prompt should load.
- Extract a real video (`POST /api/extract`) → lands on `/player/<id>` → audio streams
  (`206`/range), cover art + synced lyrics render, **Download** saves the tagged MP3.
- `/.well-known` PWA install and Android Web Share Target behave like local dev.

## Troubleshooting

- **Extraction fails "ffmpeg missing"** — should not happen in the image (apt-installed);
  confirm you're not pointing `YTDLP_PATH` somewhere bogus in env vars.
- **Storage wiped on redeploy** — expected without a mounted volume; add the disk/volume
  block as above.
- **Slow first extract** — the image installs a pinned yt-dlp on `latest`; extraction is
  single-flight per URL, so repeat requests are cached.
- **CI red** — push log from `verify-deploy.yml`; the container smoke must pass before
  the platform build is worth debugging.
