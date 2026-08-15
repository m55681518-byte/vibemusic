import { NextRequest, NextResponse } from "next/server";
import { lookupLyrics } from "@/lib/lyrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const artist = req.nextUrl.searchParams.get("artist") || "";
  const title = req.nextUrl.searchParams.get("title") || "";
  // Optional track id so the route can locate stored auto-caption (.srt)
  // files when LRCLIB and the text provider both miss.
  const id = req.nextUrl.searchParams.get("id") || undefined;
  const result = await lookupLyrics(artist, title, id);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}