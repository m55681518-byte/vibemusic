import path from "node:path";
import { promises as fsp } from "node:fs";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import YTDlpWrap from "yt-dlp-wrap";

const execFileAsync = promisify(execFile);

let wrapper: YTDlpWrap | null = null;

export function ytdlpBinaryPath(): string {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const vendor = path.join(
    process.cwd(),
    "vendor",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );
  if (existsSync(vendor)) return vendor;
  return "yt-dlp";
}

function ffprobeBinaryPath(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  const vendor = path.join(
    process.cwd(),
    "vendor",
    process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
  );
  if (existsSync(vendor)) return vendor;
  return "ffprobe";
}

/**
 * Reads the REAL duration (seconds) of a stored audio file by probing it with
 * ffprobe. Used when extract-time metadata has no duration (e.g. cobalt
 * tracks). Returns null on ANY failure — ffprobe missing, unreadable file,
 * malformed output — so callers can fall back to the original timestamps.
 * `meta.duration` (seconds) is preferred over probing when present.
 */
export async function probeAudioDuration(mp3Path: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      ffprobeBinaryPath(),
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3Path],
      { timeout: 15_000 },
    );
    const sec = Number(String(stdout).trim());
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  } catch {
    return null;
  }
}

function instance(): YTDlpWrap {
  if (!wrapper) wrapper = new YTDlpWrap(ytdlpBinaryPath());
  return wrapper;
}

export interface MediaInfo {
  id?: string;
  title?: string;
  uploader?: string;
  channel?: string;
  artist?: string;
  track?: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
  webpage_url?: string;
  extractor?: string;
  ext?: string;
}

export async function getMediaInfo(url: string): Promise<MediaInfo> {
  const raw = await instance().getVideoInfo(["--impersonate", "chrome", "--js-runtimes", "node", "--extractor-args", "youtube:player_client=default,-android_sdkless", "--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5", "--no-playlist", "--no-warnings", url]);
  return raw as MediaInfo;
}

export async function extractAudioToFile(args: string[]): Promise<string> {
  return instance().execPromise(args);
}

/**
 * Downloads a video's auto-captions (YouTube timedtext) WITHOUT touching the
 * audio/video stream — caption metadata + timedtext are served to datacenter
 * IPs even when the media stream is 403-blocked, so this works where full
 * extraction must fall back to cobalt.
 *
 * Writes `<videoId>.<lang>.srt` (converted, needs ffmpeg) or `<videoId>.<lang>.vtt`
 * (raw) files into `outDir` and resolves with the full path of every file
 * written. Never throws: yt-dlp frequently exits non-zero while still having
 * produced usable caption files (no-captions warning, 429 mid-list, srt
 * conversion needing ffmpeg), so failures are logged and whatever was written
 * is read back. Callers treat an empty list as "no captions".
 */
export async function downloadAutoCaptions(url: string, outDir: string, videoId: string): Promise<string[]> {
  // NOTE: `--sub-langs all` requests hundreds of machine-translation tracks and
  // trips YouTube's timedtext burst limit (HTTP 429) before ANY file is written.
  // Use an English-first curated list so the most likely captions are fetched
  // first; later languages are best-effort if the burst limit allows.
  const subsLangs =
    "en,en-orig,es,es-419,pt,pt-BR,ja,ko,de,fr,it,ru,ar,hi,zh-Hans,zh-Hant,nl,pl,tr,id,th,vi,uk,he,fa,sv,no,da,fi,cs,el,hu,ro,ms,ta,te,bn,ur";
  try {
    await instance().execPromise(
      [
        "--impersonate",
        "chrome",
        "--js-runtimes",
        "node",
        "--extractor-args",
        "youtube:player_client=default,-android_sdkless",
        "--skip-download",
        "--write-auto-subs",
        "--sub-langs",
        subsLangs,
        "--convert-subs",
        "srt",
        "--no-playlist",
        "--no-warnings",
        "--no-progress",
        "--output",
        path.join(outDir, "%(id)s.%(ext)s"),
        url,
      ],
      undefined,
      AbortSignal.timeout(30_000),
    );
  } catch (err) {
    console.warn(
      "[ytdlp] caption download incomplete:",
      err instanceof Error ? err.message : String(err),
    );
  }
  const names = await fsp.readdir(outDir).catch(() => [] as string[]);
  return names
    .filter(
      (name) =>
        name.startsWith(`${videoId}.`) && (name.endsWith(".srt") || name.endsWith(".vtt")),
    )
    .sort()
    .map((name) => path.join(outDir, name));
}

export function humanizeExtractorError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (/unsupported url|not a valid url/i.test(lower)) {
    return "This URL is not a supported media source.";
  }
  if (/private|login required|sign in/i.test(lower)) {
    return "This video is private or requires a login.";
  }
  if (/unexpected response from webpage request/i.test(lower)) {
    return "The site rejected the request or the extractor is currently unavailable. Try again later.";
  }
  if (/ffmpeg|avconv/i.test(lower) && /not found|not installed|missing|could not|failed/i.test(lower)) {
    return "Converting audio to MP3 requires ffmpeg, which is missing on this server.";
  }
  if (/unable to download|network is unreachable|timeout|connection/i.test(lower)) {
    return "The media could not be downloaded (network or URL problem).";
  }
  const tail = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0];
  return tail && tail.length <= 300 ? tail : "The extractor failed. Check the URL and try again.";
}