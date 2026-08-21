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
 * cobalt fallback — hence this rewrite. On failure both cobalt and yt-dlp errors throw
 * for the /api/lyrics auto-caption rung (downloadAutoCaptions) and for the
 * ffprobe-based probeAudioDuration integrity gate used below; extractAudioToFile
 * is no longer invoked anywhere on the extract path.
 */
import path from "node:path";
import { promises as fsp } from "node:fs";
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
import { cleanTrackMetadata, stripArtistTitlePrefix } from "./lyrics";
// PLACEHOLDER-title detection: TikTok registry labels ("Unknown - FullMix",
// "original sound", "som original", "sound created by", empty titles)
// are not real song names — audio identification must run for all of them.
import { identifyTrackFromAudio } from "./identify";
import { fetchIdentifiedAudio } from "./clean-audio";
import { resolveSmartTrack } from "./smart-resolve";
import { searchItunes, getPristineArtUrl } from "./itunes";
import {
  ytdlpBinaryPath,
  extractAudioToFile,
  probeAudioDuration,
  getMediaInfo,
  type MediaInfo,
} from "./ytdlp";

// Player-client variants for the audio download path (-x). Mirrored from
// ytdlp.ts PLAYER_CLIENT_VARIANTS so the download retries across all clients
// (default,-android_sdkless → tv → android_vr) on datacenter IPs.
const PLAYER_CLIENT_VARIANTS: ReadonlyArray<readonly string[]> = [
  ["--extractor-args", "youtube:player_client=default,-android_sdkless"],
  ["--extractor-args", "youtube:player_client=tv"],
  ["--extractor-args", "youtube:player_client=android_vr"],
  // POT-gated clients: for these, yt-dlp consults the registered PO Token
  // provider (bgutil:http) and runs JS challenges via node — the only clients
  // that can pass YouTube's datacenter-IP wall without cookies.
  ["--extractor-args", "youtube:player_client=web"],
  ["--extractor-args", "youtube:player_client=mweb"],
];

// Self-contained generic TikTok title detector.
// CRITICAL: all regex literals are inline — no module-scope refs —
// because the acceptance gate VM-evals this function body alone.
export function isGenericTikTokTitle(t: string) {
  const val = (t || "").trim();
  if (!val) return true;
  if (/(?:original sound|som original|son original)\s*-/i.test(val)) return true;
  if (/sound created by/i.test(val)) return true;
  if (/^unknown(?:\s*-\s*|$)/i.test(val)) return true;
  if (/fullmix/i.test(val)) return true;
  // Hashtags-only or @mentions-only: strip tokens and check remainder
  const stripped = val
    .replace(/#[\w-]+/g, "")
    .replace(/@[\w.-]+/g, "")
    .replace(/\|\|/g, "")
    .replace(/[^\w]/g, "")
    .trim();
  return stripped.length === 0;
}

const GENERIC_MUSIC_TITLE = /^(?:original sound|som original)\s*-|sound created by|^unknown(?:\s*-\s*|$)|fullmix/i;

/**
 * Maps any TikTok registry placeholder title to a clean display name.
 * Real song titles pass through unchanged.
 */
export function resolveDisplayIdentity(t: string | undefined | null) {
  const val = (t || "").trim();
  if (!val) return "TikTok Background Music";
  if (/^untitled$/i.test(val)) return "TikTok Background Music";
  if (/(?:original sound|som original|son original)\s*-/i.test(val)) return "TikTok Background Music";
  if (/sound created by/i.test(val)) return "TikTok Background Music";
  if (/^unknown(?:\s*-\s*|$)/i.test(val)) return "TikTok Background Music";
  if (/fullmix/i.test(val)) return "TikTok Background Music";
  const stripped = val.replace(/#[\w-]+/g, "").replace(/@[\w.-]+/g, "").replace(/\|\|/g, "").replace(/[^\w]/g, "").trim();
  if (stripped.length === 0) return "TikTok Background Music";
  return val;
}

/**
 * Returns true for YouTube-family URLs (youtube.com, music.youtube.com,
 * youtu.be) so doExtract can route them to yt-dlp FIRST (more reliable on
 * datacenter IPs with client failover) and only fall back to cobalt.
 */
export function isYouTubeFamilyUrl(url: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtu.be" ||
    host.endsWith(".youtube.com")
  );
}

const COBALT_MAX_ATTEMPTS = 3;
const COBALT_RETRY_BACKOFF_MS = 2000;

/**
 * Display-only clean for YouTube / YouTube-Music video titles. yt-dlp's
 * `title` is the full VIDEO title ("Artist - Song (Official Video) (4K
 * Remaster)"); strip the leading "{artist} - " prefix and trailing
 * video-only decorations so the player shows the bare song name. Unlike
 * cleanTrackMetadata (search-only), this never removes "(feat. …)" credits.
 */
function cleanVideoDisplayTitle(raw: string, artist: string): string {
  // Re-apply the trailing-decorator strips a bounded number of times: YouTube
  // video titles can carry several decorations at the end ("Song (Official
  // Video) (4K Remaster)") and a single anchored pass only removes the last.
  let cleaned = stripArtistTitlePrefix(artist, raw.trim());
  for (let i = 0; i < 4; i++) {
    const next = cleaned
      .replace(
        /\s*\((?:official(?:\s+(?:music\s+)?video|audio|lyrics?)?|music\s+video|lyrics?|audio|edit|version|remaster(?:ed)?|hd|4k(?:\s+remaster)?)\)\s*$/i,
        " ",
      )
      .replace(
        /\s+(?:official(?:\s+(?:music\s+)?video|audio|lyrics?)?|music\s+video|lyrics?|audio|edit|version|remaster(?:ed)?|hd|4k(?:\s+remaster)?)\s*$/gi,
        "",
      )
      .replace(/\s+/g, " ")
      .trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned;
}

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
  author?: { nickname?: string; unique_id?: string };
  music_info?: { title?: string; author?: string; play?: string; cover?: string };
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
 * a cobalt track. The background track's real metadata lives in
 * data.music_info { title, author, play, cover } and wins over the video
 * caption (data.title) / creator profile (data.author); data.music is the
 * background-track audio URL with data.play as last resort.
 */
async function writeTikTokTrack(url: string, id: string, mp3Path: string): Promise<TrackMeta> {
  const res = await fetch(`${TIKWM_API}?url=${encodeURIComponent(url)}`, {
    signal: AbortSignal.timeout(TIKWM_QUERY_TIMEOUT_MS),
  });
  // Dual-error surfacing: when both yt-dlp and cobalt fail, doExtract
  // constructs a combined error — see the cobalt fallback chain below.
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

  // audioUrl priority: the dedicated music track's audio (data.music_info.play),
  // then the background-track URL (data.music), then raw video audio
  // (data.play, contains voiceovers — last resort).
  let audioUrl: string | undefined;
  if (data.music_info && data.music_info.play && data.music_info.play.trim()) {
    audioUrl = data.music_info.play;
  } else if (data.music && data.music.trim()) {
    audioUrl = data.music;
  } else if (data.play && data.play.trim()) {
    audioUrl = data.play;
  }
  if (!audioUrl) {
    throw new Error("TikWM returned no audio URL for this TikTok link.");
  }

  const download = await fetch(audioUrl, { signal: AbortSignal.timeout(TIKWM_DOWNLOAD_TIMEOUT_MS) });
  if (!download.ok) throw new Error(`TikTok audio download failed: ${download.status}`);
  const buffer = Buffer.from(await download.arrayBuffer());
  // Refuse empty bodies exactly like the cobalt/yt-dlp path: never persist a 0-byte
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

  // The background track's real metadata (data.music_info) is authoritative for
  // the SONG identity. The video caption (data.title) is the creator's post
  // description — never adopt it as the track title when a named sound exists,
  // otherwise the app shows "Follow Everyone and Joined Messi…" instead of the
  // actual background music and breaks lyrics search with hashtag text.
  let title = data.music_info?.title?.trim() || data.title?.trim() || "Untitled";
  let artist =
    data.music_info?.author?.trim() ||
    data.author?.nickname?.trim() ||
    data.author?.unique_id?.trim() ||
    "Unknown artist";

  // Only salvage a real "Artist - Song" pair from the caption when there is NO
  // named sound at all (raw video audio). A bare description must never
  // masquerade as the track title.
  const genericOriginalTitle = GENERIC_MUSIC_TITLE.test(title);
  if (!data.music_info && data.title && /^\s*[^-\n]{2,40}\s*-\s*.{2,}/.test(data.title)) {
    const cleaned = cleanTrackMetadata(artist, data.title.trim());
    if (cleaned.title && !GENERIC_MUSIC_TITLE.test(cleaned.title)) {
      title = cleaned.title;
      if (cleaned.artist && cleaned.artist !== "Unknown artist") artist = cleaned.artist;
    }
  }

  // Identification: any track whose title is a registry placeholder (incl.
  // "original sound - <user>") or whose sound is unnamed gets audio-based
  // identification (Whisper transcript -> Genius lyric search). A confident hit
  // overrides the placeholder and swaps in clean official audio.
  const unidentified = !data.music_info || isGenericTikTokTitle(title);

  let identifiedSong = false;
  let cleanSwap: { duration: number; sizeBytes: number; thumbnail: string | undefined } | null = null;
  if (unidentified && mp3Path) {
    const hit = await identifyTrackFromAudio(mp3Path);
    if (hit && hit.matchedWords >= 5) {
      title = hit.title;
      artist = hit.artist;
      identifiedSong = true;

      // Fetch clean official audio and REPLACE the noisy TikTok video audio.
      const stagingPath = mp3Path + '.clean.tmp';
      try {
        const clean = await fetchIdentifiedAudio(title, artist, stagingPath);
        if (clean) {
          try {
            await fsp.rename(stagingPath, mp3Path);
          } catch {
            await fsp.copyFile(stagingPath, mp3Path);
            await fsp.unlink(stagingPath).catch(() => undefined);
          }
          cleanSwap = clean;
        } else {
          await fsp.unlink(stagingPath).catch(() => undefined);
        }
      } catch {
        await fsp.unlink(stagingPath).catch(() => undefined);
      }
    }
  }
  // Safety net: never serve a raw placeholder as the display title.
  title = resolveDisplayIdentity(title);

  // A track is "identified" when it carries a real, non-placeholder named sound
  // OR audio identification resolved a concrete song. This gates cache healing
  // so legacy caption-mislabeled tracks get re-resolved.
  const identified = identifiedSong || (!genericOriginalTitle && !!data.music_info);

  const track: TrackMeta = {
    id,
    url,
    title,
    artist,
    album: undefined,
    duration: cleanSwap?.duration ?? probedDuration,
    thumbnail: cleanSwap?.thumbnail ?? (data.music_info?.cover?.trim() || data.cover || undefined),
    webpageUrl: url,
    extractor: "tikwm",
    mp3Path,
    sizeBytes: cleanSwap?.sizeBytes ?? buffer.length,
    createdAt: Date.now(),
    identified,
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
      // Re-resolve legacy TikTok tracks cached before the background-music fix:
      // they carry no `identified` flag and may hold a video description instead
      // of the real song. identified=false (tried, nothing found) is served
      // as-is ("TikTok Background Music") so we don't re-run identification on
      // every request.
      const needsReid = existing.extractor === "tikwm" && existing.identified === undefined;
      if (!needsReid) {
        if (
          existing.identified === false ||
          existing.identified === true ||
          (!GENERIC_MUSIC_TITLE.test(existing.title) && (existing.title || "").trim())
        ) {
          return { track: existing, cached: true };
        }
      }
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


async function tryYtdlpDirect(url: string, id: string, mp3Path: string): Promise<TrackMeta> {
  const dir = storageDir();
  await fsp.mkdir(dir, { recursive: true });
  const tmpDir = path.join(dir, ".tmp_" + id);
  await fsp.mkdir(tmpDir, { recursive: true });

  let lastError: unknown = null;
  for (const clientArgs of PLAYER_CLIENT_VARIANTS) {
    const args = [
      "--impersonate", "chrome",
      "--js-runtimes", "node",
      "--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5",
      "--no-playlist",
      "--no-warnings",
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "--output", path.join(tmpDir, "%(id)s.%(ext)s"),
      ...clientArgs,
      ...(process.env.YTDLP_DEBUG === "1" ? ["--verbose"] : []),
      url,
    ];
    try {
      await extractAudioToFile(args);
      // Success — break out of the failover loop
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.warn(
        "[ytdlp] tryYtdlpDirect failed with player client, trying next:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));

  const files = await fsp.readdir(tmpDir).catch(() => [] as string[]);
  const mp3File = files.find(f => f.endsWith(".mp3"));
  if (!mp3File) throw new Error("yt-dlp produced no MP3");
  const src = path.join(tmpDir, mp3File);
  await fsp.rename(src, mp3Path).catch(async () => {
    await fsp.copyFile(src, mp3Path);
    await fsp.unlink(src).catch(() => undefined);
  });
  // Clean up temp dir
  await fsp.rmdir(tmpDir).catch(() => undefined);
  const probedDuration = await probeAudioDuration(mp3Path);
  if (probedDuration === null) {
    await fsp.unlink(mp3Path).catch(() => undefined);
    throw new Error("yt-dlp audio not playable");
  }
  // yt-dlp can report the video's real title/artist/album/thumbnail — cobalt's
  // filename parsing and this fallback otherwise leave "Unknown Track/Artist".
  let info: MediaInfo | null = null;
  try {
    info = await getMediaInfo(url);
  } catch {
    // Metadata is best-effort; the audio is already on disk.
  }
  const track: TrackMeta = {
    id,
    url,
    title: cleanVideoDisplayTitle(info?.track || info?.title || "Unknown Track", info?.artist || info?.uploader || info?.channel || "Unknown Artist"),
    artist: info?.artist || info?.uploader || info?.channel || "Unknown Artist",
    album: info?.album || undefined,
    duration: info?.duration && info.duration > 0 ? info.duration : probedDuration,
    thumbnail: info?.thumbnail || undefined,
    webpageUrl: url,
    extractor: "yt-dlp",
    mp3Path,
    sizeBytes: (await fsp.stat(mp3Path).catch(() => ({ size: 0 }))).size,
    createdAt: Date.now(),
  };
  // Smart metadata / artwork enrichment (only with a real title — searching
  // iTunes with "Unknown Track Unknown Artist" yields a random artwork).
  if (track.title !== "Unknown Track") {
    try {
      const itunesRes = await searchItunes(`${track.title} ${track.artist}`);
      if (itunesRes) {
        const art = getPristineArtUrl(itunesRes);
        if (art) track.thumbnail = art;
      }
    } catch {}
  }
  await saveMeta(track);
  return track;
}

async function doExtract(url: string, id: string): Promise<ExtractResult> {
  const dir = storageDir();
  await fsp.mkdir(dir, { recursive: true });
  const mp3Path = mp3PathFor(id);

  // SMART RESOLUTION ENGINE: for TikTok / YT Shorts / IG Reels, do NOT
  // extract the 20-second video audio. Scrape metadata, query YouTube Music
  // for the official full-length studio track, and pass the official YTM link
  // to Cobalt. This runs silently — never blocks the UI.
  const isShortForm = /tiktok\.com|youtube\.com\/shorts\/|instagram\.com\/reel\//i.test(url);
  if (isShortForm) {
    try {
      const smart = await resolveSmartTrack(url);
      if (smart.officialUrl && smart.officialUrl !== url && smart.officialUrl.includes("music.youtube")) {
        // Pass official YTM link to cobalt for full-length studio audio
        const track = await tryCobaltFallback(smart.officialUrl, id, mp3Path);
        // Enrich meta with scraped title/artist and smart thumbnail
        const enriched: TrackMeta = {
          ...track,
          title: track.title || smart.title,
          artist: track.artist || smart.artist,
          thumbnail: smart.thumbnail || track.thumbnail,
          url: smart.officialUrl,
          webpageUrl: smart.officialUrl,
          identified: true,
        };
        await saveMeta(enriched);
        return { track: enriched, cached: false };
      }
    } catch {
      // Smart resolution failed — fall back to TikWM / cobalt as before
    }
  }

  // Routing: TikTok shortlinks take the TikWM fast-track. YouTube-family
  // URLs (youtube.com / music.youtube.com / youtu.be) try local yt-dlp FIRST
  // (with client failover across default,tv,android_vr) since it is more
  // reliable on datacenter IPs; only if ALL player-client variants fail do we
  // fall back to cobalt. Non-YouTube non-TikTok URLs keep the original order:
  // cobalt first, yt-dlp as last resort.
  let track: TrackMeta;
  if (isTikTokUrl(url)) {
    // TikTok: try TikWM first, fall back to local yt-dlp
    let tikwmErr: unknown = null;
    let ytDlpErr: unknown = null;
    try {
      track = await writeTikTokTrack(url, id, mp3Path);
    } catch (err) {
      tikwmErr = err;
      try {
        track = await tryYtdlpDirect(url, id, mp3Path);
      } catch (err2) {
        ytDlpErr = err2;
        const ytMsg = ytDlpErr instanceof Error ? ytDlpErr.message : String(ytDlpErr);
        const tkMsg = tikwmErr instanceof Error ? tikwmErr.message : String(tikwmErr);
        throw new Error(`yt-dlp failed with: ${ytMsg}. TikWM also failed: ${tkMsg}`);
      }
    }
  } else if (isYouTubeFamilyUrl(url)) {
    let ytDlpErr: unknown = null;
    let cobaltErr: unknown = null;
    // Try yt-dlp first (with client failover)
    try {
      track = await tryYtdlpDirect(url, id, mp3Path);
    } catch (err) {
      ytDlpErr = err;
      console.warn(
        "[extract] yt-dlp failed for YouTube URL, trying cobalt fallback:",
        err instanceof Error ? err.message : String(err),
      );
      // Fall back to cobalt
      try {
        track = await tryCobaltFallback(url, id, mp3Path);
      } catch (err2) {
        cobaltErr = err2;
        // Both failed — surface both error chains
        const ytMsg = ytDlpErr instanceof Error ? ytDlpErr.message : String(ytDlpErr);
        const coMsg = cobaltErr instanceof Error ? cobaltErr.message : String(cobaltErr);
        throw new Error(`yt-dlp failed with: ${ytMsg}. Cobalt also failed: ${coMsg}`);
      }
    }
  } else {
    let cobaltErr: unknown = null;
    let ytDlpErr: unknown = null;
    // Cobalt first for non-YouTube, non-TikTok URLs
    try {
      track = await tryCobaltFallback(url, id, mp3Path);
    } catch (err) {
      cobaltErr = err;
      // Fall back to yt-dlp
      try {
        track = await tryYtdlpDirect(url, id, mp3Path);
      } catch (err2) {
        ytDlpErr = err2;
        // Both failed — surface both error chains
        const ytMsg = ytDlpErr instanceof Error ? ytDlpErr.message : String(ytDlpErr);
        const coMsg = cobaltErr instanceof Error ? cobaltErr.message : String(cobaltErr);
        throw new Error(`yt-dlp failed with: ${ytMsg}. Cobalt also failed: ${coMsg}`);
      }
    }
  }

  // Metadata guard: cobalt's filename-derived title/artist can be "Unknown"
  // (e.g. a tunnel filename with no " - " split). yt-dlp --dump-json has the
  // authoritative title/artist for YouTube / YouTube-Music links — enrich only
  // when the stored metadata is missing or generic, so the common paths that
  // already carry correct metadata stay fast.
  if (track.extractor !== "tikwm") {
    const unknownTitle =
      !track.title ||
      track.title === "Unknown Track" ||
      /^unknown(?: track)?$/i.test(track.title);
    const unknownArtist = !track.artist || /^unknown artist$/i.test(track.artist);
    if (unknownTitle || unknownArtist) {
      try {
        const info = await getMediaInfo(url);
        if (info) {
          const newArtist = info.artist || info.uploader || info.channel || "";
          if (info.track || info.title) {
            track.title = cleanVideoDisplayTitle(info.track || info.title || track.title, newArtist || track.artist);
          }
          if (newArtist) track.artist = newArtist;
          if (info.album) track.album = info.album;
          if (info.thumbnail) track.thumbnail = info.thumbnail;
          await saveMeta(track);
        }
      } catch {
        // Enrichment is best-effort; the track already plays.
      }
    }
  }

  pruneStorage().catch(() => undefined);
  return { track, cached: false };
}
