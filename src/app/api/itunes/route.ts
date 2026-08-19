import { NextResponse } from "next/server";
import { searchItunes, getPristineArtUrl, fetchCoverImage } from "@/lib/itunes";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get("query") || "";
  try {
    const result = await searchItunes(query);
    if (!result) return NextResponse.json({ error: "No results" }, { status: 404 });
    const url = getPristineArtUrl(result);
    if (!url) return NextResponse.json({ error: "No art URL" }, { status: 404 });
    // Optionally download to server storage and serve; for simplicity return URL
    return NextResponse.json({ url, title: result.trackName, artist: result.artistName });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
