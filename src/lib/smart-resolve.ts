/**
 * Smart Track Resolution Engine — "Stealth" extraction pipeline.
 * For TikTok / YT Shorts / IG Reels: scrape metadata, query YTM, pass official link to Cobalt.
 */

export interface SmartMeta {
  title: string;
  artist: string;
  thumbnail?: string;
  youtubeMusicUrl?: string;
}

function isShortFormUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return true;
    if (host === "youtube.com" || host === "youtu.be") {
      // YouTube Shorts have /shorts/ in path
      if (u.pathname.includes("/shorts/")) return true;
    }
    if (host === "instagram.com" || host === "www.instagram.com" || host === "reels.instagram.com") {
      if (u.pathname.includes("/reel/") || u.pathname.includes("/reels/")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function scrapeTikwmMeta(url: string): Promise<SmartMeta | null> {
  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const d = body?.data;
    if (!d) return null;
    const title = d.music_info?.title || d.title || "";
    const artist = d.music_info?.author || d.author?.nickname || d.author?.unique_id || "";
    const thumb = d.music_info?.cover || d.cover || undefined;
    return { title: title.trim(), artist: artist.trim(), thumbnail: thumb };
  } catch {
    return null;
  }
}

async function scrapeYoutubeMeta(url: string): Promise<SmartMeta | null> {
  try {
    // Use a lightweight metadata endpoint (yt-dlp --dump-json via a proxy, or oEmbed)
    // For stealth mode we just do best-effort title extraction from URL / page title
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";
    // Try to extract artist from meta tags
    const artistMatch = html.match(/"artist"\s*[:=]\s*"([^"]+)"/i) || html.match(/"name"\s*[:=]\s*"([^"]+)"/i);
    const artist = artistMatch ? artistMatch[1].trim() : "Unknown artist";
    return { title, artist, thumbnail: undefined };
  } catch {
    return null;
  }
}

async function queryYouTubeMusic(query: string): Promise<string | null> {
  // Query YouTube Music search and return the first official track URL
  try {
    const q = encodeURIComponent(query);
    const res = await fetch(`https://music.youtube.com/search?q=${q}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Extract first /watch?v= link that looks like a song (not playlist)
    const match = html.match(/href="(\/watch\?v=[^"]+)"/);
    if (match) {
      return `https://music.youtube.com${match[1]}`;
    }
    return null;
  } catch {
    return null;
  }
}

export async function resolveSmartTrack(url: string): Promise<SmartMeta & { officialUrl: string; stage: "metadata" | "stream" }> {
  // Stage 1: metadata (instant ~100ms)
  const meta = isShortFormUrl(url) ? await (url.includes("tiktok") ? scrapeTikwmMeta(url) : scrapeYoutubeMeta(url)) : null;
  const cleanMeta = meta || { title: "Unknown Track", artist: "Unknown Artist" };

  // Stage 2: query YouTube Music for official full-length studio track
  const query = `${cleanMeta.title} ${cleanMeta.artist}`.trim();
  const officialUrl = await queryYouTubeMusic(query);
  const finalUrl = officialUrl || url;

  return {
    ...cleanMeta,
    officialUrl: finalUrl,
    stage: officialUrl ? "stream" : "metadata",
  };
}
