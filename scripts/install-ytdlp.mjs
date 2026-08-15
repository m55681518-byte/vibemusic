/**
 * Ensures a yt-dlp binary is available for VibeMusic.
 * Checks (in order): YTDLP_PATH env, <project>/vendor/yt-dlp(.exe),
 * any yt-dlp on PATH. Downloads from the official GitHub release if missing.
 * Runs on `postinstall`.
 */
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const binName = isWin ? "yt-dlp.exe" : "yt-dlp";
const vendorDir = path.join(projectRoot, "vendor");
const binPath = path.join(vendorDir, binName);
const url = isWin
  ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
  : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

async function main() {
  if (process.env.YTDLP_PATH) {
    console.log("[vibemusic] YTDLP_PATH is set — using external binary, skipping download.");
    return;
  }
  if (existsSync(binPath)) {
    console.log(`[vibemusic] yt-dlp binary present at ${binPath}`);
    return;
  }
  const { spawnSync } = await import("node:child_process");
  const onPath = spawnSync(isWin ? "where" : "which", ["yt-dlp"], { encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout.trim()) {
    console.log(`[vibemusic] Using yt-dlp on PATH: ${onPath.stdout.trim().split(/\r?\n/)[0]}`);
    return;
  }
  mkdirSync(vendorDir, { recursive: true });
  console.log(`[vibemusic] Downloading ${url} ...`);
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(binPath, buf);
    if (!isWin) {
      spawnSync("chmod", ["+x", binPath], { encoding: "utf8" });
    }
    console.log(`[vibemusic] Installed yt-dlp (${buf.length} bytes) at ${binPath}`);
  } catch (err) {
    console.warn(`[vibemusic] Could not download yt-dlp: ${err.message}`);
    console.warn("[vibemusic] Install it manually or set YTDLP_PATH. https://github.com/yt-dlp/yt-dlp/releases");
  }
}

main();