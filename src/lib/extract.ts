/**
 * External-API-only extraction ("server-side proxy"): /api/extract never
 * executes local yt-dlp. TikTok links take the TikWM fast-track (resolves
 * shortlinks server-side, beating TikTok's datacenter-IP Captcha); every other
 * URL goes to a round-robin pool of public Cobalt instances. The remote audio
 * is downloaded here, ffprobe-verified, and persisted to local storage, so the
 * player keeps streaming /api/audio/{id} exactly as before.
 *
 * Legacy note: the pre-rewrite path ran local yt-dlp first with --impersonate
 * chrome, --extractor-args "youtube:player_client=default,-android_sdkless"
 * (failing over to youtube:player_client=tv) and --downloader-args
 * "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5", then
 * fell back to cobalt. TikTok anti-bot served a Captcha to datacenter IPs
 * which yt-dlp read as "login required", and that failure also skipped the
 * cobalt fallback — hence this rewrite. yt-dlp survives only in src/lib/ytdlp.ts
 * for the /api/lyrics auto-caption rung (downloadAutoCaptions) and for the
 * ffprobe-based probeAudioDuration integrity gate used below; extractAudioToFile
 * is no longer invoked anywhere on the extract path.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
import { probeAudioDuration } from "./ytdlp";
import {
  getCobaltAudio,
  deriveThumbnailUrl,
  BROWSER_USER_AGENT,
  type CobaltResult,
} from "./cobalt";
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

const TIKWM_API = "https://www.tikwm.com/api/";
const TIKWM_QUERY_TIMEOUT_MS = 30_000;
const TIKWM_DOWNLOAD_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Matches TikTok video links (full www.tiktok.com URLs AND vt.tiktok.com /
 * vm.tiktok.com shortlinks) so they take the TikWM fast-track instead of the
 * generic cobalt route.
 */
export function isTikTokUrl(url: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return false;
  }
  return host === "tiktok.com" || host.endsWith(".tiktok.com");
}

interface TikwmData {
  title?: string;
  cover?: string;
  music?: string;
  play?: string;
  author?: { nickname?: string };
  music_info?: { author?: string };
}

interface TikwmResponse {
  code?: number;
  msg?: string;
  data?: TikwmData;
}

/**
 * TikTok fast-track: resolves the (possibly shortlink) video through the public
 * TikWM API — which resolves vt.tiktok.com/vm.tiktok.com shortlinks server-side,
 * bypassing the datacenter-IP Captcha that broke local yt-dlp — then downloads
 * the returned remote audio, ffprobe-verifies it, and persists it exactly like
 * a cobalt track. data.music is the audio URL (fall back to data.play when
 * empty); data.title + data.cover feed the metadata.
 */
async function writeTikTokTrack(url: string, id: string, mp3Path: string): Promise<TrackMeta> {
  const res = await fetch(`${TIKWM_API}?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(TIKWM_QUERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`TikWM API failed: ${res.status}`);

  let body: TikwmResponse;
  try {
    body = (await res.json()) as TikwmResponse;
  } catch {
    throw new Error("TikWM API returned a non-JSON response (likely a bot challenge).");
  }

  const data = body?.data;
  if (!data || body.code !== 0) {
    throw new Error(`TikWM could not resolve this TikTok link: ${body?.msg ?? "unknown error"}`);
  }

  // Prioritise the official background track URL over raw video audio.
  // data.music is the background track (may contain voiceovers if no dedicated
  // music track is available), data.music_info.play is an alternate music URL,
  // and data.play is the raw video audio (contains voiceovers). We only fall
  // back to data.play when neither data.music nor data.music_info.play is available.
  let audioUrl: string | undefined;
  if (data.music && data.music.trim()) {
    audioUrl = data.music;
  } else if (data.music_info && data.music_info.play && data.music_info.play.trim()) {
    audioUrl = data.music_info.play;
  } else if (data.play && data.play.trim()) {
    audioUrl = data.play;
  }
  if (!audioUrl) {
    throw new Error("TikWM returned no audio URL for this TikTok link.");
  }

  const download = await fetch(audioUrl, { signal: AbortSignal.timeout(TIKWM_DOWNLOAD_TIMEOUT_MS) });
  if (!download.ok) throw new Error(`TikTok audio download failed: ${download.status}`);
  const buffer = Buffer.from(await download.arrayBuffer());
  // Refuse empty bodies exactly like the cobalt path: never persist a 0-byte
  // mp3 + meta that /api/audio can never play.
  if (!buffer.length) throw new Error("TikWM audio yielded 0 bytes.");
  await fsp.writeFile(mp3Path, buffer);

  // ffprobe-verify BEFORE persisting: delete + error on an unverifiable file so
  // a broken track is never saved or served, and store the REAL probed duration
  // for /api/lyrics timestamp rescaling.
  const probedDuration = await probeAudioDuration(mp3Path);
  if (probedDuration === null) {
    await fsp.unlink(mp3Path).catch(() => undefined);
    throw new Error("TikWM audio is not playable (ffprobe verification failed).");
  }

  const track: TrackMeta = {
    id,
    url,
    title: data.title?.trim() || "Untitled",
    artist: data.author?.nickname?.trim() || data.music_info?.author?.trim() || "Unknown artist",
    album: undefined,
    duration: probedDuration,
    thumbnail: data.cover || undefined,
    webpageUrl: url,
    extractor: "tikwm",
    mp3Path,
    sizeBytes: buffer.length,
    createdAt: Date.now(),
  };
  await saveMeta(track);
  return track;
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

  // CDNs (e.g. googlevideo redirect targets) 403 or serve blocked HTML to
  // requests that look like a bare server, so the download must look like a
  // real desktop Chrome tab: full browser UA, a source-origin Referer, and an
  // Accept header that asks for audio first.
  let referer = "https://www.youtube.com/";
  try {
    referer = new URL(url).origin + "/";
  } catch {
    // url is normalized upstream; fall back to the YouTube default above.
  }

  for (const cobalt of candidates) {
    try {
      const response = await fetch(cobalt.audioUrl, {
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Referer: referer,
          Accept: "audio/*,*/*;q=0.9",
        },
        signal: AbortSignal.timeout(120_000),
      });
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
          `[extract] cobalt attempt ${attempt}/${COBALT_MAX_ATTEMPTS} failed, retrying in ${COBALT_RETRY_BACKOFF_MS}ms:`,
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

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Extracts the first valid http(s) URL from arbitrary text, filtering out
 * promotional links such as /tiktoklite and /app endings. Android share
 * sheets append captions and punctuation to the link ("Check this out
 * https://vt.tiktok.com/xyz", "…thanks!"), so the raw string is scanned for
 * the first parseable http(s) URL that is not a promotional link and everything
 * else is ignored. Returns null when no valid URL is present so callers can
 * treat it as missing.
 */
export function extractValidUrl(input: string): string | null {
  for (const match of input.matchAll(URL_IN_TEXT)) {
    const candidate = match[0].replace(/[.,;:!?'")\]}]+$/, "");
    try {
      new URL(candidate);
      // Promotional links (TikTok Lite /app endings) are not valid video URLs
      if (/\/tiktoklite$/i.test(candidate) || /\/app$/i.test(candidate)) {
        continue; // skip this URL and scan the next one
      }
      return candidate;
    } catch {
      // Bare scheme (e.g. "https://") or malformed URL — keep scanning.
    }
  }
  return null;
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
  const mp3Path = mp3PathFor(id);

  // TikTok shortlinks take the TikWM fast-track; every other URL goes straight
  // to the cobalt pool (retry loop + backoff below). No local yt-dlp attempt.
  const track = isTikTokUrl(url)
    ? await writeTikTokTrack(url, id, mp3Path)
    : await tryCobaltFallback(url, id, mp3Path);

  pruneStorage().catch(() => undefined);
  return { track, cached: false };
}
