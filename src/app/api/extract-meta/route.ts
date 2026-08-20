import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const rawUrl = body?.url || "";
    const trimmed = rawUrl.trim();
    if (!trimmed.startsWith("http")) {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }
    let url = trimmed;
    try {
      url = new URL(trimmed).toString();
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    const id = require("crypto").createHash("sha256").update(url).digest("hex").slice(0, 32);

    let title = "Loading…";
    let artist = "Unknown artist";
    let thumbnail: string | undefined;

    try {
      const isTik = /tiktok\.com|youtube\.com\/shorts\/|instagram\.com\/reel\//i.test(url);
      if (isTik) {
        const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json();
          const d = data?.data;
          if (d) {
            title = d.music_info?.title || d.title || title;
            artist = d.music_info?.author || d.author?.nickname || "Unknown artist";
            thumbnail = d.music_info?.cover || d.cover || undefined;
          }
        }
      } else {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const html = await(res.text());
          const m = html.match(/<title>([^<]+)<\/title>/i);
          if (m) {
            const raw = m[1].trim();
            const split = raw.split("-");
            title = split.pop()?.trim() || raw;
            artist = split[0]?.trim() || "Unknown artist";
          }
        }
      }
    } catch {
      // metadata fetch is best-effort
    }

    return NextResponse.json({ id, title: title || "Unknown Track", artist: artist || "Unknown artist", thumbnail, url, stage: "metadata" });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Meta fetch failed" }, { status: 500 });
  }
}
