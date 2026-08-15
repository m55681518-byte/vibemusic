import path from "node:path";
import { existsSync } from "node:fs";
import YTDlpWrap from "yt-dlp-wrap";

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
  const raw = await instance().getVideoInfo(["--impersonate", "chrome", "--extractor-args", "youtube:player_client=default,-android_sdkless", "--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5", "--no-playlist", "--no-warnings", url]);
  return raw as MediaInfo;
}

export async function extractAudioToFile(args: string[]): Promise<string> {
  return instance().execPromise(args);
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