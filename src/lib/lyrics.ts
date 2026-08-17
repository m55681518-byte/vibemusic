import { promises as fsp } from "node:fs";
import path from "node:path";
import { storageDir, isValidId } from "./store";
import { downloadAutoCaptions } from "./ytdlp";

const BASE = (process.env.LRCLIB_BASE_URL || "https://lrclib.net/api").replace(/\/$/, "");
const GENIUS_SEARCH = "https://genius.com/api/search/song";
const UA = "VibeMusic/1.0 (PWA audio extractor; contact: vibemusic@example.com)";
// Genius serves its public site (and the key-free search API it backs) to
// browser-like clients; plain fetch agents get blocked with an HTML challenge.
const GENIUS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

export interface LyricsResult {
  synced: string | null;
  plain: string | null;
  /** Present only when the track is confirmed instrumental (no vocals). */
  isInstrumental?: boolean;
}

export interface SrtLine {
  start: number;
  end: number;
  text: string;
}

const SRT_TIMECODE =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/**
 * Parses an SRT caption file into timed lines (seconds + plain text).
 * Pure Node, no dependencies.
 */
export function parseSrt(srt: string): SrtLine[] {
  const captions: SrtLine[] = [];
  for (const block of srt.replace(/\r/g, "").split(/\n{2,}/)) {
    // SRT blocks are: <index>\n<start> --> <end>\n<text lines> — locate the
    // timecode line rather than assuming it is the first line.
    const lines = block.split("\n");
    const tcIndex = lines.findIndex((line) => SRT_TIMECODE.test(line));
    if (tcIndex < 0) continue;
    const m = lines[tcIndex].match(SRT_TIMECODE);
    if (!m) continue;
    const toSeconds = (h: number, min: number, sec: number, ms: number): number =>
      h * 3600 + min * 60 + sec + Number(String(ms).padEnd(3, "0").slice(0, 3)) / 1000;
    const text = lines
      .slice(tcIndex + 1)
      .map((line) => line.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (!text) continue;
    captions.push({
      start: toSeconds(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])),
      end: toSeconds(Number(m[5]), Number(m[6]), Number(m[7]), Number(m[8])),
      text,
    });
  }
  return captions;
}

export function captionsToPlain(captions: SrtLine[]): string {
  return captions.map((caption) => caption.text).join("\n");
}

/**
 * Builds an LRC string ("[mm:ss.mmm] text" per line) from timed caption lines
 * so the karaoke UI can render them in sync with playback. Long instrumental
 * gaps (> 5s) between captions emit a "♪" marker line at the previous caption
 * end + 0.5s so the karaoke UI clears the prior lyric during the break.
 */
export function buildLrc(captions: SrtLine[]): string {
  const lines = [];
  for (let i = 0; i < captions.length; i++) {
    const caption = captions[i];
    const text = caption.text.trim();
    if (text) {
      const totalMs = Math.round(caption.start * 1000);
      const m = Math.floor(totalMs / 60000);
      const s = Math.floor((totalMs % 60000) / 1000);
      const ms = totalMs % 1000;
      lines.push(`[${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}] ${text}`);
    }
    const next = captions[i + 1];
    if (next && next.start - caption.end > 5) {
      // Instrumental break: mark the gap with a ♪ line at caption end + 0.5s.
      const markerMs = Math.round((caption.end + 0.5) * 1000);
      const mm = Math.floor(markerMs / 60000);
      const ss = Math.floor((markerMs % 60000) / 1000);
      const mss = markerMs % 1000;
      lines.push(`[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(mss).padStart(3, "0")}] ♪`);
    }
  }
  return lines.join("\n");
}

async function getJson(pathname: string): Promise<Record<string, unknown>[] | Record<string, unknown> | null> {
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>[] | Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function toResult(item: unknown): LyricsResult | null {
  const r = asRecord(item);
  if (!r) return null;
  const synced = typeof r.syncedLyrics === "string" ? r.syncedLyrics : null;
  const plain = typeof r.plainLyrics === "string" ? r.plainLyrics : null;
  if (synced || plain) return { synced, plain };
  return null;
}

interface LrclibHit {
  hit: LyricsResult | null;
  /** Original track duration (seconds) reported by LRCLIB, for time rescaling. */
  duration: number | null;
  instrumental: boolean;
}

/**
 * Ranks a title-only LRCLIB hit: exact trackName match first (the ORIGINAL
 * track beats covers/edits), then synced lyrics, then a duration closest to
 * the real audio duration. Higher is better.
 */
function rankTitleOnlyHit(
  r: Record<string, unknown>,
  titleLower: string,
  actualDurationSec?: number,
): number {
  let score =
    typeof r.trackName === "string" && r.trackName.toLowerCase() === titleLower
      ? 1_000_000
      : 0;
  if (typeof r.syncedLyrics === "string" && r.syncedLyrics) score += 100_000;
  if (typeof r.duration === "number" && actualDurationSec && actualDurationSec > 0) {
    score -= Math.abs(r.duration - actualDurationSec);
  }
  return score;
}

/** Step 1 - LRCLIB time-synced lyrics (primary source). */
async function lookupLrclib(
  artist: string,
  title: string,
  actualDurationSec?: number,
): Promise<LrclibHit> {
  const a = encodeURIComponent(artist);
  const t = encodeURIComponent(title);

  const exact = await getJson(`/get?artist_name=${a}&track_name=${t}`);
  const exactRec = exact && !Array.isArray(exact) ? asRecord(exact) : null;
  if (exactRec) {
    const duration = typeof exactRec.duration === "number" ? exactRec.duration : null;
    // LRCLIB flags instrumentals on the track record itself.
    if (exactRec.instrumental === true) return { hit: null, duration, instrumental: true };
    const hit = toResult(exactRec);
    if (hit) return { hit, duration, instrumental: false };
  }

  const q = encodeURIComponent(`${title} ${artist}`.trim());
  const list = await getJson(`/search?q=${q}`);
  if (Array.isArray(list) && list.length) {
    const titleLower = title.toLowerCase();
    const best =
      list.find((x) => {
        const r = asRecord(x);
        return (
          r &&
          typeof r.trackName === "string" &&
          !r.instrumental &&
          (r.trackName.toLowerCase().includes(titleLower) || titleLower.includes(r.trackName.toLowerCase()))
        );
      }) || list[0];
    const rec = asRecord(best);
    const hit = toResult(best);
    if (hit) {
      return {
        hit,
        duration: rec && typeof rec.duration === "number" ? rec.duration : null,
        instrumental: false,
      };
    }
  }

  // TITLE-ONLY fallback: when the parsed artist is junk (cobalt names files
  // like "BAILA LENTO (Slowed) - Release.mp3" → artist="Release"), the
  // artist+title query above finds nothing even though the track exists on
  // LRCLIB. Search by the CLEANED title alone and pick the best
  // non-instrumental hit whose trackName contains the title.
  const titleOnly = await getJson(`/search?q=${encodeURIComponent(title)}`);
  const titleList = Array.isArray(titleOnly) ? titleOnly : [];
  if (titleList.length) {
    const titleLower = title.toLowerCase();
    const usable = titleList
      .map(asRecord)
      .filter(
        (r): r is Record<string, unknown> =>
          r !== null &&
          typeof r.trackName === "string" &&
          !r.instrumental &&
          r.trackName.toLowerCase().includes(titleLower),
      )
      .sort(
        (a, b) =>
          rankTitleOnlyHit(b, titleLower, actualDurationSec) -
          rankTitleOnlyHit(a, titleLower, actualDurationSec),
      );
    const best = usable[0];
    if (best) {
      const hit = toResult(best);
      if (hit) {
        return {
          hit,
          duration: typeof best.duration === "number" ? best.duration : null,
          instrumental: false,
        };
      }
    }
  }
  return { hit: null, duration: null, instrumental: false };
}

// --- Genius (key-free public text-lyrics fallback) ---

function balancedDivEnd(html: string, openEnd: number): number {
  let depth = 1;
  let i = openEnd + 1;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf("<div", i);
    const nextClose = html.indexOf("</div>", i);
    if (nextClose < 0) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 4;
    } else {
      depth -= 1;
      i = nextClose + 6;
    }
  }
  return i;
}

function extractLyricsBlocks(html: string): string[] {
  const blocks: string[] = [];
  let pos = 0;
  for (;;) {
    const idx = html.indexOf('data-lyrics-container="true"', pos);
    if (idx < 0) break;
    const divStart = html.lastIndexOf("<div", idx);
    const openEnd = html.indexOf(">", idx);
    if (divStart < 0 || openEnd < 0) break;
    const end = balancedDivEnd(html, openEnd);
    blocks.push(html.slice(divStart, end));
    pos = end;
  }
  return blocks;
}

function stripExcludedBlocks(block: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const idx = block.indexOf('data-exclude-from-selection="true"', pos);
    if (idx < 0) {
      out += block.slice(pos);
      break;
    }
    const divStart = block.lastIndexOf("<div", idx);
    const openEnd = block.indexOf(">", idx);
    if (divStart < 0 || openEnd < 0) {
      out += block.slice(pos);
      break;
    }
    out += block.slice(pos, divStart);
    pos = balancedDivEnd(block, openEnd);
  }
  return out;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&ldquo;/gi, "\u201c")
    .replace(/&rdquo;/gi, "\u201d")
    .replace(/&lsquo;/gi, "\u2018")
    .replace(/&rsquo;/gi, "\u2019")
    .replace(/&hellip;/gi, "\u2026")
    .replace(/&mdash;/gi, "\u2014")
    .replace(/&ndash;/gi, "\u2013")
    .replace(/&middot;/gi, "\u00b7");
}

function htmlToLyricsText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br[^>]*>/gi, "\n")
      .replace(/<\/(?:p|div|section|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** Step 2 - Genius public search + song page, key-free. */
async function searchGenius(artist: string, title: string): Promise<string | null> {
  const q = encodeURIComponent(`${title} ${artist}`.trim());
  let data: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${GENIUS_SEARCH}?q=${q}`, {
      headers: { "User-Agent": GENIUS_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const response = asRecord(data?.response);
  if (!response) return null;

  const hits: unknown[] = [];
  if (Array.isArray(response.hits)) hits.push(...response.hits);
  if (Array.isArray(response.sections)) {
    for (const section of response.sections) {
      const s = asRecord(section);
      if (s && Array.isArray(s.hits)) hits.push(...s.hits);
    }
  }
  if (!hits.length) return null;

  const titleLower = title.toLowerCase();
  const best =
    hits.find((hit) => {
      const result = asRecord(asRecord(hit)?.result);
      return (
        result &&
        typeof result.full_title === "string" &&
        result.full_title.toLowerCase().includes(titleLower)
      );
    }) ?? hits[0];
  const result = asRecord(asRecord(best)?.result);
  if (!result || typeof result.path !== "string") return null;

  let pageHtml: string;
  try {
    const res = await fetch(`https://genius.com${result.path}`, {
      headers: { "User-Agent": GENIUS_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    pageHtml = await res.text();
  } catch {
    return null;
  }

  const blocks = extractLyricsBlocks(pageHtml);
  const plain = blocks
    .map((block) => htmlToLyricsText(stripExcludedBlocks(block)))
    .filter(Boolean)
    .join("\n");
  return plain || null;
}

// --- Step 3 - platform auto-captions (SRT) as final text fallback ---

async function captionsForId(id: string): Promise<LyricsResult | null> {
  if (!isValidId(id)) return null;
  let files: string[];
  try {
    files = await fsp.readdir(storageDir());
  } catch {
    return null;
  }
  const captionFile = files
    .filter((name) => name.startsWith(`${id}.`) && name.endsWith(".srt"))
    .sort()[0];
  if (!captionFile) return null;
  try {
    const raw = await fsp.readFile(path.join(storageDir(), captionFile), "utf8");
    const captions = parseSrt(raw);
    const plain = captionsToPlain(captions);
    return plain ? { synced: null, plain } : null;
  } catch {
    return null;
  }
}

// --- Step 4 - onDemand platform auto-captions (fresh YouTube timedtext) ---

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Extracts the 11-char video id from a YouTube / YouTube Music URL, else null. */
function videoIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^(?:www|m)\./, "").toLowerCase();
  if (!["youtube.com", "music.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)) {
    return null;
  }
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\/+/, "").split("/")[0];
    return YOUTUBE_VIDEO_ID.test(id) ? id : null;
  }
  const v = parsed.searchParams.get("v");
  if (v && YOUTUBE_VIDEO_ID.test(v)) return v;
  const pathMatch = parsed.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  return pathMatch ? pathMatch[1] : null;
}

/**
 * Fetches a video's auto-captions ON DEMAND (yt-dlp caption-only — timedtext
 * is served to datacenter IPs even when the audio stream is 403-blocked) and
 * returns them as synced LRC + plain text. Any failure (no captions, DRM,
 * bot block, timeout, missing binary) resolves to null, never throws.
 */
async function fetchOnDemandCaptions(url: string): Promise<LyricsResult | null> {
  const videoId = videoIdFromUrl(url);
  if (!videoId) return null;
  // Rebuild a clean watch URL so stray params (si=, list=, …) never leak in.
  const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const dir = storageDir();
    await fsp.mkdir(dir, { recursive: true });
    const captionFiles = await downloadAutoCaptions(cleanUrl, dir, videoId);
    if (!captionFiles.length) return null;
    // Prefer converted .srt (ffmpeg present) over raw .vtt; among those,
    // English captions first, else the first available language.
    const byExt = [...captionFiles].sort(
      (a, b) => Number(b.endsWith(".srt")) - Number(a.endsWith(".srt")),
    );
    const preferred = byExt.find((file) => /\.en(?:-|\.|$)/i.test(path.basename(file)));
    const file = preferred ?? byExt[0];
    const raw = await fsp.readFile(file, "utf8");
    const captions = parseSrt(raw);
    if (!captions.length) return null;
    return { synced: buildLrc(captions), plain: captionsToPlain(captions) };
  } catch (err) {
    console.warn(
      "[lyrics] on-demand caption fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Cleans artist/title for SEARCH only (display metadata stays untouched).
 * Strips edition noise so the ORIGINAL track can be found on LRCLIB/Genius:
 * "(Slowed + Reverb)", "[TikTok Edit]", "sped up", "remix", "nightcore",
 * "#hashtags", "@usernames", "official video", trailing " - Single", and
 * any bracketed/parenthesized decorations. Collapses internal whitespace.
 */
export function cleanTrackMetadata(artist: string, title: string): { artist: string; title: string } {
  const clean = (raw: string): string =>
    raw
      .replace(/#\w+/g, " ") // #hashtags
      .replace(/@\w+/g, " ") // @usernames
      .replace(/\[[^\]]*\]/g, " ") // [bracketed] decorations
      .replace(
        /\(([^)]*(?:slowed|sped up|reverb|remix|nightcore|tiktok|tik tok|official|video|audio|lyric|edit|version|remaster|instrumental|feat)[^)]*)\)/gi,
        " ",
      )
      .replace(
        /\b(?:slowed|sped up|spedup|reverb|remix|nightcore|tiktok|tik tok)(?:\s*\+\s*(?:slowed|sped up|spedup|reverb|remix|nightcore|tiktok|tik tok))*/gi,
        " ",
      )
      .replace(/\s+[-–—]\s*(?:single|remaster(?:ed)?|edit|version|official(?:\s+\w+)?)?\s*$/i, "")
      .replace(
        /\s+(?:official(?:\s+(?:music\s+)?video|audio|lyrics?)?|music\s+video|lyrics?|audio|edit|version|remaster(?:ed)?|single|explicit|hd|4k)\s*$/gi,
        "",
      )
      .replace(/\s+/g, " ")
      .trim();

  return { artist: clean(artist), title: clean(title) };
}

const LRC_TIME_TAG = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Multiplies every [mm:ss.xx] timestamp in an LRC string by `ratio`
 * (actualDuration / originalDuration) so slowed/sped-up audio stays in sync
 * with the original synced lyrics. Non-time lines pass through untouched.
 */
export function rescaleLrc(lrc: string, ratio: number): string {
  return lrc.replace(LRC_TIME_TAG, (whole, m, s, ms) => {
    const fraction = (ms ?? "0").padEnd(3, "0").slice(0, 3);
    const totalMs = Math.round((Number(m) * 60 + Number(s) + Number(fraction) / 1000) * 1000 * ratio);
    const mm = Math.floor(totalMs / 60000);
    const ss = Math.floor((totalMs % 60000) / 1000);
    const milli = totalMs % 1000;
    return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(milli).padStart(3, "0")}]`;
  });
}

/**
 * Waterfall: LRCLIB (synced) -> Genius public page (plain) -> stored
 * auto-captions for the track id (plain) -> on-demand YouTube auto-captions
 * (synced LRC). `id` and `sourceUrl` are optional so existing artist/title
 * callers keep working unchanged. `actualDurationSec` is the real duration of
 * the stored MP3 (from metadata or ffprobe); when it differs from the
 * ORIGINAL track's LRCLIB duration, synced timestamps are rescaled by
 * ratio = actual / original so slowed/sped-up audio stays in sync.
 */
export async function lookupLyrics(
  artist: string,
  title: string,
  id?: string,
  sourceUrl?: string,
  actualDurationSec?: number,
): Promise<LyricsResult> {
  // Search with CLEANED names for the ORIGINAL track; the caller keeps the
  // raw artist/title for display.
  const cleaned = cleanTrackMetadata(artist, title);
  const a = cleaned.artist;
  const t = cleaned.title;
  const hasQuery = Boolean(a || t);
  if (!hasQuery && !id && !sourceUrl) return { synced: null, plain: null };

  if (hasQuery) {
    const lrclib = await lookupLrclib(a, t, actualDurationSec);
    // LRCLIB reports the track as instrumental: no lyrics to find.
    if (lrclib.instrumental) return { synced: null, plain: null, isInstrumental: true };
    if (lrclib.hit) {
      let { synced, plain } = lrclib.hit;
      // Time-scale normalization: when both durations are known and differ
      // by more than 2%, rescale every timestamp by ratio = actual / original.
      if (synced && actualDurationSec && lrclib.duration) {
        const ratio = actualDurationSec / lrclib.duration;
        if (Number.isFinite(ratio) && ratio > 0.3 && ratio < 3.0 && Math.abs(ratio - 1) > 0.02) {
          synced = rescaleLrc(synced, ratio);
        }
      }
      return { synced, plain };
    }

    const geniusPlain = await searchGenius(a, t);
    if (geniusPlain) return { synced: null, plain: geniusPlain };
  }

  if (id) {
    const captionHit = await captionsForId(id);
    if (captionHit) return captionHit;
  }

  if (sourceUrl) {
    const onDemandHit = await fetchOnDemandCaptions(sourceUrl);
    if (onDemandHit) return onDemandHit;
  }

  return { synced: null, plain: null };
}
