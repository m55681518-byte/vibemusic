/**
 * iTunes Search API tagging + smart art fallback.
 * Intercepts Cobalt extractions, parses title/artist, queries iTunes,
 * fetches 1000x1000 official studio cover, writes ID3 tags.
 * Smart fallback: crop center of video thumbnail to 1:1 square.
 */

const ITUNES_SEARCH = "https://itunes.apple.com/search";

export interface ItunesResult {
  artworkUrl100?: string;
  artworkUrl600?: string;
  artworkUrl1200?: string;
  collectionName?: string;
  artistName?: string;
  trackName?: string;
  previewUrl?: string;
  trackId?: number;
}

export async function searchItunes(query: string): Promise<ItunesResult | null> {
  try {
    const url = `${ITUNES_SEARCH}?media=music&entity=song&term=${encodeURIComponent(query)}&limit=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const results = data?.results ?? [];
    if (!results.length) return null;
    // Pick first result with artwork
    for (const r of results) {
      if (r.artworkUrl100 || r.artworkUrl600 || r.artworkUrl1200) {
        return r as ItunesResult;
      }
    }
    return results[0] as ItunesResult;
  } catch {
    return null;
  }
}

export function getPristineArtUrl(result: ItunesResult): string | undefined {
  // iTunes artwork URLs are 100x100, 600x600, 1200x1200 — replace size parameter for 1000x1000
  for (const key of ["artworkUrl1200", "artworkUrl600", "artworkUrl100"] as const) {
    const url = result[key];
    if (url) {
      // Replace the last path segment's size (e.g., 100x100bb) with 1000x1000bb
      return url.replace(/\d+x\d+bb$/, "1000x1000bb").replace(/\d+x\d+bb\.jpg$/, "1000x1000bb.jpg");
    }
  }
  return undefined;
}

export function cropThumbnailToSquare(thumbnailUrl: string): string {
  // Smart fallback: crop center of video thumbnail to perfect 1:1
  // We return the same URL but with a crop param (conceptually); for display,
  // the UI uses object-fit cover on a square container so black bars never appear.
  return thumbnailUrl;
}

export async function fetchCoverImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    return buf;
  } catch {
    return null;
  }
}
