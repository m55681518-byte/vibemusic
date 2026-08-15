import { promises as fsp } from "node:fs";
import path from "node:path";
import { storageDir, isValidId } from "./store";

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

/** Step 1 - LRCLIB time-synced lyrics (primary source). */
async function lookupLrclib(artist: string, title: string): Promise<LyricsResult | null> {
  const a = encodeURIComponent(artist);
  const t = encodeURIComponent(title);

  const exact = await getJson(`/get?artist_name=${a}&track_name=${t}`);
  const exactHit = exact && !Array.isArray(exact) ? toResult(exact) : null;
  if (exactHit) return exactHit;

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
    const hit = toResult(best);
    if (hit) return hit;
  }
  return null;
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

/**
 * Waterfall: LRCLIB (synced) -> Genius public page (plain) -> stored
 * auto-captions for the track id (plain). `id` is optional so existing
 * artist/title-only callers keep working unchanged.
 */
export async function lookupLyrics(artist: string, title: string, id?: string): Promise<LyricsResult> {
  const a = artist.trim();
  const t = title.trim();
  const hasQuery = Boolean(a || t);
  if (!hasQuery && !id) return { synced: null, plain: null };

  if (hasQuery) {
    const lrclibHit = await lookupLrclib(a, t);
    if (lrclibHit) return lrclibHit;

    const geniusPlain = await searchGenius(a, t);
    if (geniusPlain) return { synced: null, plain: geniusPlain };
  }

  if (id) {
    const captionHit = await captionsForId(id);
    if (captionHit) return captionHit;
  }

  return { synced: null, plain: null };
}
