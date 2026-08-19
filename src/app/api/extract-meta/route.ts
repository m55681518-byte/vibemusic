import { NextResponse } from "next/server";
import { normalizeUrl, extractValidUrl, isTikTokUrl } from "@/lib/extract";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const rawUrl = body?.url || "";
    const url = normalizeUrl(rawUrl);
    const id = require("@/lib/store").idForUrl(url);
    
    // Fast metadata only — no audio download
    let title = "Loading…";
    let artist = "Unknown artist";
    let thumbnail: string | undefined;
    
    if (isTikTokUrl(url)) {
      try {
        const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json();
          const d = data?.data;
          if (d) {
            title = d.music_info?.title || d.title || title;
            artist = d.music_info?.author || d.author?.nickname || artist;
            thumbnail = d.music_info?.cover || d.cover || undefined;
          }
        }
      } catch {}
    } else {
      // Quick title scrape from URL or oEmbed
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const html = await res.text();
          const m = html.match(/<title>([^<]+)<\/title>/i);
          if (m) title = m[1].trim().split("-").pop()?.trim() || m[1].trim();
        }
      } catch {}
    }
    
    return NextResponse.json({ id, title: title || "Unknown Track", artist: artist || "Unknown Artist", thumbnail, url, stage: "metadata" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Meta fetch failed" }, { status: 500 });
  }
}
