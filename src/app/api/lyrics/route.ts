import { NextRequest, NextResponse } from "next/server";
import { lookupLyrics } from "@/lib/lyrics";
import { loadMeta, mp3PathFor } from "@/lib/store";
import { probeAudioDuration } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const artist = req.nextUrl.searchParams.get("artist") || "";
  const title = req.nextUrl.searchParams.get("title") || "";
  // Optional track id so the route can resolve the actual duration for
  // LRCLIB timestamp rescaling.
  const id = req.nextUrl.searchParams.get("id") || undefined;
  const meta = id ? await loadMeta(id) : null;

  // Actual MP3 duration: prefer the duration captured at extract time, else
  // probe the stored file with ffprobe (both may be absent → no rescaling).
  let actualDurationSec: number | null = null;
  if (id) {
    actualDurationSec = meta?.duration ?? null;
    if (!actualDurationSec) {
      actualDurationSec = await probeAudioDuration(mp3PathFor(id));
    }
  }

  // LYRICS PIPELINE (decentralized): LRCLIB is the source. Pass the RAW user
  // artist/title so LRCLIB ranking can recognize edition tags like
  // "(Slowed)"/"(Sped Up)" (lookupLyrics cleans internally for the search
  // key). No Whisper, no caption scraping.
  const result = await lookupLyrics(
    artist,
    title,
    id,
    meta?.webpageUrl ?? meta?.url,
    actualDurationSec ?? undefined,
  );

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}