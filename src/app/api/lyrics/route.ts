import { NextRequest, NextResponse } from "next/server";
import { lookupLyrics, cleanTrackMetadata } from "@/lib/lyrics";
import { whisperTranscribe } from "@/lib/whisper";
import { loadMeta, mp3PathFor, fileExists } from "@/lib/store";
import { probeAudioDuration } from "@/lib/ytdlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const artist = req.nextUrl.searchParams.get("artist") || "";
  const title = req.nextUrl.searchParams.get("title") || "";
  // Optional track id so the route can locate stored auto-caption (.srt)
  // files when LRCLIB and the text provider both miss, can resolve the
  // source video URL for the on-demand caption fallback, and can hand the
  // stored MP3 to the Whisper speech-to-text tier as a last resort.
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

  // Search with CLEANED names so the ORIGINAL track is found; the raw
  // artist/title stay untouched for the UI. The source video URL (webpageUrl,
  // else the raw input URL) feeds the on-demand caption fallback.
  const cleaned = cleanTrackMetadata(artist, title);
  const result = await lookupLyrics(
    cleaned.artist,
    cleaned.title,
    id,
    meta?.webpageUrl ?? meta?.url,
    actualDurationSec ?? undefined,
  );

  if (result.synced || result.plain || result.isInstrumental) {
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  }

  // Tier 2/3 — Whisper speech-to-text fallback: only possible with an id so
  // we can read the stored MP3. Runs zero-key against public Hugging Face
  // Gradio spaces (with the optional keyed Groq path as a last resort) and
  // quietly no-ops on any failure.
  if (id) {
    const mp3Path = mp3PathFor(id);
    if (await fileExists(mp3Path)) {
      const whisper = await whisperTranscribe(mp3Path);
      if (whisper?.isInstrumental) {
        return NextResponse.json({ synced: null, plain: null, isInstrumental: true }, {
          headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
        });
      }
      if (whisper?.synced || whisper?.plain) {
        return NextResponse.json({ synced: whisper.synced, plain: whisper.plain }, {
          headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
        });
      }
    }
  }

  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}