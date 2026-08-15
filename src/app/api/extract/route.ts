import { NextRequest, NextResponse } from "next/server";
import { getTrackInfo } from "@/lib/extract";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let url: string | undefined;
  try {
    const body = (await req.json()) as { url?: unknown };
    url = typeof body?.url === "string" ? body.url : undefined;
  } catch {
    url = undefined;
  }

  if (!url) {
    return NextResponse.json({ error: "Missing 'url' in request body." }, { status: 400 });
  }

  try {
    const { track, cached } = await getTrackInfo(url);
    return NextResponse.json({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album ?? undefined,
      duration: track.duration ?? undefined,
      thumbnail: track.thumbnail ?? undefined,
      extractor: track.extractor ?? undefined,
      audioUrl: `/api/audio/${track.id}`,
      metaUrl: `/api/meta/${track.id}`,
      cached,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Extraction failed.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}