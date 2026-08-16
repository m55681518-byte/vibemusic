import path from "node:path";
import { promises as fsp } from "node:fs";
import {
  getMediaInfo,
  extractAudioToFile,
  probeAudioDuration,
  humanizeExtractorError,
} from "./ytdlp";
import { getCobaltAudio, deriveThumbnailUrl, type CobaltResult } from "./cobalt";
import {
  storageDir,
  idForUrl,
  mp3PathFor,
  metaPathFor,
  saveMeta,
  loadMeta,
  fileExists,
  pruneStorage,
  type TrackMeta,
} from "./store";

const COBALT_MAX_ATTEMPTS = 3;
const COBALT_RETRY_BACKOFF_MS = 2000;

/**
 * Player-client variants tried IN ORDER for the yt-dlp download. The default
 * client (-android_sdkless) hits YouTube's datacenter-IP sign-in wall
 * ("Sign in to confirm you're not a bot" / "This video is private or requires
 * a login"); the tv client (YouTube's embedded-TV player) is generally NOT
 * blocked on server IPs, so it is the failover before cobalt is ever tried.
 */
const CLIENT_VARIANTS: ReadonlyArray<readonly string[]> = [
  ["--extractor-args", "youtube:player_client=default,-android_sdkless"],
  ["--extractor-args", "youtube:player_client=tv"],
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBotBlockError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /sign in to confirm|not a bot|bot|403|request blocked|captcha|private/i.test(message);
}

/**
 * Downloads the cobalt-provided audio, writes it to disk, and builds a TrackMeta
 * with a derived cover thumbnail (YouTube/TikTok) so cobalt tracks show art.
 *
 * Candidates arrive in COBALT_INSTANCES order; the FIRST tunnel that yields
 * real bytes wins. A tunnel whose body is empty (0 bytes) is the cobalt
 * empty-tunnel bug — it must never be written to disk nor saved in meta, so we
 * skip it and try the next instance's tunnel instead.
 */
async function writeCobaltTrack(
  url: string,
  id: string,
  mp3Path: string,
  candidates: CobaltResult[],
): Promise<TrackMeta> {
  let lastError: unknown = null;

  for (const cobalt of candidates) {
    try {
      const response = await fetch(cobalt.audioUrl, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Cobalt download failed: ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      // Refuse empty tunnel bodies: skip to the next candidate instead of
      // persisting a 0-byte mp3 + meta that /api/audio can never play.
      if (!buffer.length) {
        lastError = new Error(`Cobalt tunnel for ${cobalt.audioUrl} yielded 0 bytes`);
        continue;
      }
      await fsp.writeFile(mp3Path, buffer);
      // ffprobe-verify BEFORE persisting: a truncated/unverifiable mp3 would
      // "play partly then stop" on the client. Refuse it (delete + try the
      // next candidate) so a broken track is never saved or served, and store
      // the REAL probed duration for /api/lyrics timestamp rescaling.
      const probedDuration = await probeAudioDuration(mp3Path);
      if (probedDuration === null) {
        await fsp.unlink(mp3Path).catch(() => undefined);
        lastError = new Error(
          `Cobalt audio for ${cobalt.audioUrl} is not playable (ffprobe verification failed)`,
        );
        continue;
      }
      const track: TrackMeta = {
        id,
        url,
        title: cobalt.title,
        artist: cobalt.artist,
        album: undefined,
        duration: probedDuration,
        thumbnail: deriveThumbnailUrl(url),
        webpageUrl: url,
        extractor: "cobalt",
        mp3Path,
        sizeBytes: buffer.length,
        createdAt: Date.now(),
      };
      await saveMeta(track);
      return track;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `Cobalt download failed for all instances. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function tryCobaltFallback(
  url: string,
  id: string,
  mp3Path: string,
): Promise<TrackMeta> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= COBALT_MAX_ATTEMPTS; attempt++) {
    try {
      const cobalt = await getCobaltAudio(url);
      return await writeCobaltTrack(url, id, mp3Path, cobalt);
    } catch (err) {
      lastError = err;
      if (attempt < COBALT_MAX_ATTEMPTS) {
        console.error(
          `[extract] cobalt fallback attempt ${attempt}/${COBALT_MAX_ATTEMPTS} failed, retrying in ${COBALT_RETRY_BACKOFF_MS}ms:`,
          err instanceof Error ? err.message : String(err),
        );
        await sleep(COBALT_RETRY_BACKOFF_MS);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const singleFlight = new Map<string, Promise<ExtractResult>>();

export interface ExtractResult {
  track: TrackMeta;
  cached: boolean;
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (
    !/^https?:\/\//i.test(trimmed) ||
    !trimmed.slice(trimmed.indexOf("://") + 3).includes(".")
  ) {
    throw new Error("Invalid URL. Paste a full link such as https://…");
  }
  return new URL(trimmed).toString();
}

export async function getTrackInfo(rawUrl: string): Promise<ExtractResult> {
  const url = normalizeUrl(rawUrl);
  const id = idForUrl(url);

  const existing = await loadMeta(id);
  if (existing && (await fileExists(existing.mp3Path))) {
    // A cached file that exists but is 0 bytes is the cobalt empty-tunnel bug:
    // never serve it as a valid track — delete the stale file/meta and
    // re-extract so the real audio replaces it.
    const stat = await fsp.stat(existing.mp3Path).catch(() => null);
    if (stat && stat.size > 0 && existing.sizeBytes > 0) {
      return { track: existing, cached: true };
    }
    await fsp.unlink(existing.mp3Path).catch(() => undefined);
    await fsp.unlink(metaPathFor(id)).catch(() => undefined);
  }

  const pending = singleFlight.get(url);
  if (pending) return pending;

  const run = doExtract(url, id);
  singleFlight.set(url, run);
  try {
    return await run;
  } finally {
    singleFlight.delete(url);
  }
}

async function doExtract(url: string, id: string): Promise<ExtractResult> {
  const dir = storageDir();
  await fsp.mkdir(dir, { recursive: true });
  const outTemplate = path.join(dir, `${id}.%(ext)s`);
  const mp3Path = mp3PathFor(id);

  let info: Awaited<ReturnType<typeof getMediaInfo>>;
  try {
    info = await getMediaInfo(url);
  } catch (err) {
    console.error("[extract] yt-dlp error:", err instanceof Error ? err.message : String(err));
    // Last resort on ANY extractor failure (bot block, TikTok "Unexpected
    // response", etc.): try the cobalt fallback before surfacing the error.
    try {
      const track = await tryCobaltFallback(url, id, mp3Path);
      return { track, cached: false };
    } catch (cobaltErr) {
      console.error("[extract] cobalt fallback failed:", cobaltErr instanceof Error ? cobaltErr.message : String(cobaltErr));
    }
    if (isBotBlockError(err)) {
      console.error("[extract] yt-dlp bot block detected (cobalt fallback also failed)");
    }
    throw new Error(humanizeExtractorError(err));
  }

  const title = info?.title || info?.track || "Untitled";
  const artist = info?.artist || info?.uploader || info?.channel || "Unknown artist";

  const base: string[] = [
    "--impersonate",
    "chrome",
    "--js-runtimes",
    "node",
    "--downloader-args",
    "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
    "-f",
    "bestaudio/best",
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-mtime",
    "--restrict-filenames",
    // Pull the platform's auto-captions alongside the audio so the lyrics
    // fallback chain has a final text source: --write-auto-subs
    // --convert-subs srt writes <id>.<lang>.srt next to the MP3.
    "--write-auto-subs",
    "--convert-subs",
    "srt",
    "--output",
    outTemplate,
  ];
  const runAttempt = (extra: string[], clientArgs: readonly string[]) =>
    extractAudioToFile([...base, ...clientArgs, ...extra, url]);

  let extractError: unknown = null;
  let probedDuration: number | null = null;
  // Try every player client (default first, then tv) so a single blocked
  // client never kills the whole request; after each variant ffprobe-verify
  // the written file and only accept one that really plays.
  for (const clientArgs of CLIENT_VARIANTS) {
    try {
      await runAttempt(
        [
          "--extract-audio",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "0",
          "--embed-thumbnail",
          "--add-metadata",
        ],
        clientArgs,
      );
    } catch (err) {
      extractError = err;
      try {
        await runAttempt(["--extract-audio", "--audio-format", "mp3"], clientArgs);
      } catch (err2) {
        extractError = err2;
      }
    }
    // The real acceptance test: ffprobe the stored file. A truncated/empty/
    // unverifiable mp3 would "play partly then stop" on the client, so a
    // failed probe deletes the file and falls through to the next client.
    probedDuration = await probeAudioDuration(mp3Path);
    if (probedDuration !== null) break;
    await fsp.unlink(mp3Path).catch(() => undefined);
  }

  if (probedDuration === null) {
    console.error("[extract] yt-dlp error:", extractError instanceof Error ? extractError.message : String(extractError));
    if (isBotBlockError(extractError)) {
      console.error("[extract] yt-dlp bot block, trying cobalt fallback");
    }
    // General extractor failure (e.g. TikTok "Unexpected response from webpage
    // request") gets the cobalt fallback too, as a last resort.
    try {
      const track = await tryCobaltFallback(url, id, mp3Path);
      return { track, cached: false };
    } catch (cobaltErr) {
      console.error("[extract] cobalt fallback failed:", cobaltErr instanceof Error ? cobaltErr.message : String(cobaltErr));
    }
    throw new Error(
      humanizeExtractorError(extractError ?? new Error("Extraction finished without producing a file.")),
    );
  }

  const stat = await fsp.stat(mp3Path);

  const track: TrackMeta = {
    id,
    url,
    title,
    artist,
    album: info?.album,
    // Real, probed duration (ffprobe on the stored file) — feeds /api/lyrics
    // timestamp rescaling for slowed/sped-up variants.
    duration: probedDuration ?? info?.duration,
    thumbnail: info?.thumbnail,
    webpageUrl: info?.webpage_url,
    extractor: info?.extractor,
    mp3Path,
    sizeBytes: stat.size,
    createdAt: Date.now(),
  };
  await saveMeta(track);
  pruneStorage().catch(() => undefined);
  return { track, cached: false };
}