import { NextRequest, NextResponse } from "next/server";
import { lookupLyrics } from "@/lib/lyrics";
import { loadMeta } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const artist = req.nextUrl.searchParams.get("artist") || "";
  const title = req.nextUrl.searchParams.get("title") || "";
  // Optional track id so the route can locate stored auto-caption (.srt)
  // files when LRCLIB and the text provider both miss, and can resolve the
  // source video URL for the on-demand caption fallback.
  const id = req.nextUrl.searchParams.get("id") || undefined;
  const meta = id ? await loadMeta(id) : null;
  const result = await lookupLyrics(artist, title, id, meta?.webpageUrl);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}