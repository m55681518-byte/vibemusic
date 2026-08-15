import { NextRequest, NextResponse } from "next/server";
import { lookupLyrics } from "@/lib/lyrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const artist = req.nextUrl.searchParams.get("artist") || "";
  const title = req.nextUrl.searchParams.get("title") || "";
  const result = await lookupLyrics(artist, title);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}