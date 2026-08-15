import { NextRequest, NextResponse } from "next/server";
import { loadMeta } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const meta = await loadMeta(ctx.params.id);
  if (!meta) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: meta.id,
    title: meta.title,
    artist: meta.artist,
    album: meta.album ?? undefined,
    duration: meta.duration ?? undefined,
    thumbnail: meta.thumbnail ?? undefined,
    webpageUrl: meta.webpageUrl ?? undefined,
    extractor: meta.extractor ?? undefined,
    audioUrl: `/api/audio/${meta.id}`,
    sizeBytes: meta.sizeBytes,
  });
}