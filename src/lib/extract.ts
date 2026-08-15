import path from "node:path";
import { promises as fsp } from "node:fs";
import {
  getMediaInfo,
  extractAudioToFile,
  humanizeExtractorError,
} from "./ytdlp";
import {
  storageDir,
  idForUrl,
  mp3PathFor,
  saveMeta,
  loadMeta,
  fileExists,
  pruneStorage,
  type TrackMeta,
} from "./store";

const singleFlight = new Map<string, Promise<ExtractResult>>();

export interface ExtractResult {
  track: TrackMeta;
  cached: boolean;
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (
    !/^https?:\/\//i.test(trimmed) ||
    !trimmed.slice(trimmed.indexOf("://") + 3).includes(".")
  ) {
    throw new Error("Invalid URL. Paste a full link such as https://…");
  }
  return new URL(trimmed).toString();
}

export async function getTrackInfo(rawUrl: string): Promise<ExtractResult> {
  const url = normalizeUrl(rawUrl);
  const id = idForUrl(url);

  const existing = await loadMeta(id);
  if (existing && (await fileExists(existing.mp3Path))) {
    return { track: existing, cached: true };
  }

  const pending = singleFlight.get(url);
  if (pending) return pending;

  const run = doExtract(url, id);
  singleFlight.set(url, run);
  try {
    return await run;
  } finally {
    singleFlight.delete(url);
  }
}

async function doExtract(url: string, id: string): Promise<ExtractResult> {
  const dir = storageDir();
  await fsp.mkdir(dir, { recursive: true });
  const outTemplate = path.join(dir, `${id}.%(ext)s`);

  let info: Awaited<ReturnType<typeof getMediaInfo>>;
  try {
    info = await getMediaInfo(url);
  } catch (err) {
    console.error("[extract] yt-dlp error:", err instanceof Error ? err.message : String(err));
    throw new Error(humanizeExtractorError(err));
  }

  const title = info?.title || info?.track || "Untitled";
  const artist = info?.artist || info?.uploader || info?.channel || "Unknown artist";

  const base: string[] = [
    "--impersonate",
    "chrome-146",
    "--extractor-args",
    "youtube:player_client=android",
    "-f",
    "bestaudio/best",
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-mtime",
    "--restrict-filenames",
    "--output",
    outTemplate,
  ];
  const runAttempt = (extra: string[]) => extractAudioToFile([...base, ...extra, url]);

  let extractError: unknown = null;
  try {
    await runAttempt([
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "--embed-thumbnail",
      "--add-metadata",
    ]);
  } catch (err) {
    extractError = err;
    try {
      await runAttempt(["--extract-audio", "--audio-format", "mp3"]);
    } catch (err2) {
      extractError = err2;
    }
  }

  const mp3Path = mp3PathFor(id);
  if (extractError || !(await fileExists(mp3Path))) {
    console.error("[extract] yt-dlp error:", extractError instanceof Error ? extractError.message : String(extractError));
    throw new Error(
      humanizeExtractorError(extractError ?? new Error("Extraction finished without producing a file.")),
    );
  }

  const stat = await fsp.stat(mp3Path);

  const track: TrackMeta = {
    id,
    url,
    title,
    artist,
    album: info?.album,
    duration: info?.duration,
    thumbnail: info?.thumbnail,
    webpageUrl: info?.webpage_url,
    extractor: info?.extractor,
    mp3Path,
    sizeBytes: stat.size,
    createdAt: Date.now(),
  };
  await saveMeta(track);
  pruneStorage().catch(() => undefined);
  return { track, cached: false };
}