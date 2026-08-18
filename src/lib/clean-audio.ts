/**
 * Fetches the CLEAN official audio for an identified song.
 *
 * Step 1: yt-dlp search+download via `ytsearch1:"<artist> - <title>"` with
 *         player-client failover (default → tv).
 * Step 2 (fallback): Invidious search → Cobalt tunnel download.
 *
 * NEVER throws (every failure resolves to null).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ytdlpBinaryPath, probeAudioDuration } from "./ytdlp";
import { getCobaltAudio, deriveThumbnailUrl, BROWSER_USER_AGENT } from "./cobalt";

const execFileAsync = promisify(execFile);

const INVIDIOUS_INSTANCES = [
  "https://invidious.nerdvpn.de",
  "https://yewtu.be",
  "https://invidious.f5.si",
];

const PLAYER_CLIENT_VARIANTS: ReadonlyArray<readonly string[]> = [
  ["--extractor-args", "youtube:player_client=default,-android_sdkless"],
  ["--extractor-args", "youtube:player_client=tv"],
];

export async function fetchIdentifiedAudio(
  title: string,
  artist: string,
  destPath: string,
): Promise<{ duration: number; sizeBytes: number; thumbnail: string | undefined } | null> {
  try {
    // STEP 1: yt-dlp search + download
    const result = await ytdlpSearchDownload(title, artist, destPath);
    if (result) return result;

    // STEP 2: Invidious -> Cobalt fallback
    return await invidiousCobaltFallback(title, artist, destPath);
  } catch {
    return null;
  }
}

async function ytdlpSearchDownload(
  title: string,
  artist: string,
  destPath: string,
): Promise<{ duration: number; sizeBytes: number; thumbnail: string | undefined } | null> {
  const tmpDir = path.join(
    os.tmpdir(),
    `vibemusic-swap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  try {
    await fsp.mkdir(tmpDir, { recursive: true });

    // ytsearch1:"<artist> - <title>" — encode via concat, not JSON
    const query = `ytsearch1:"${artist} - ${title}"`;
    const baseArgs = [
      "--impersonate", "chrome",
      "--js-runtimes", "node",
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "--output", path.join(tmpDir, "%(id)s.%(ext)s"),
      query,
    ];

    for (const clientArgs of PLAYER_CLIENT_VARIANTS) {
      try {
        await execFileAsync(ytdlpBinaryPath(), [...baseArgs, ...clientArgs], {
          timeout: 120_000,
        });

        // Find the produced .mp3 file
        const files = await fsp.readdir(tmpDir).catch(() => [] as string[]);
        const mp3File = files.find((f) => f.endsWith(".mp3"));
        if (!mp3File) return null;

        const videoId = mp3File.replace(/\.mp3$/i, "");
        const fullPath = path.join(tmpDir, mp3File);

        // ffprobe-verify
        const duration = await probeAudioDuration(fullPath);
        if (duration === null) {
          await fsp.unlink(fullPath).catch(() => undefined);
          return null;
        }

        // Move to destPath (rename if same volume, else copy+unlink)
        try {
          await fsp.rename(fullPath, destPath);
        } catch {
          await fsp.copyFile(fullPath, destPath);
          await fsp.unlink(fullPath).catch(() => undefined);
        }

        const stat = await fsp.stat(destPath);
        const thumbnail = deriveThumbnailUrl(`https://www.youtube.com/watch?v=${videoId}`);
        return { duration, sizeBytes: stat.size, thumbnail };
      } catch {
        // Try next player client variant
      }
    }
    return null;
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function invidiousCobaltFallback(
  title: string,
  artist: string,
  destPath: string,
): Promise<{ duration: number; sizeBytes: number; thumbnail: string | undefined } | null> {
  const query = `${artist} - ${title}`;
  const ytUrlBase = "https://www.youtube.com/watch?v=";

  // Try Invidious search to get a videoId
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(`${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const results = (await res.json()) as Array<{ videoId?: string; type?: string }>;
      const video = results.find((r) => r.type === "video" && r.videoId);
      if (!video?.videoId) continue;

      const ytUrl = ytUrlBase + video.videoId;
      const cobaltResults = await getCobaltAudio(ytUrl);

      for (const candidate of cobaltResults) {
        try {
          const response = await fetch(candidate.audioUrl, {
            headers: {
              "User-Agent": BROWSER_USER_AGENT,
              Referer: "https://www.youtube.com/",
              Accept: "audio/*,*/*;q=0.9",
            },
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) continue;

          const buffer = Buffer.from(await response.arrayBuffer());
          if (!buffer.length) continue;

          await fsp.writeFile(destPath, buffer);

          const duration = await probeAudioDuration(destPath);
          if (duration === null) {
            await fsp.unlink(destPath).catch(() => undefined);
            continue;
          }

          const stat = await fsp.stat(destPath);
          const thumbnail = deriveThumbnailUrl(ytUrl);
          return { duration, sizeBytes: stat.size, thumbnail };
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}
