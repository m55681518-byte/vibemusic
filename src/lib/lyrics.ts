const BASE = (process.env.LRCLIB_BASE_URL || "https://lrclib.net/api").replace(/\/$/, "");
const UA = "VibeMusic/1.0 (PWA audio extractor; contact: vibemusic@example.com)";

export interface LyricsResult {
  synced: string | null;
  plain: string | null;
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

export async function lookupLyrics(artist: string, title: string): Promise<LyricsResult> {
  const a = encodeURIComponent(artist.trim());
  const t = encodeURIComponent(title.trim());
  if (!a && !t) return { synced: null, plain: null };

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
  return { synced: null, plain: null };
}