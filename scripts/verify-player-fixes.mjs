// Acceptance gate for Turn D: Player reliability + cover-art + fallback coverage.
// Hard checks (all must PASS after the fix; gate FAILs on the current code):
//  1. src/lib/extract.ts cobalt fallback blocks set `thumbnail` (not `undefined`)
//     so the player can show cover art for cobalt-extracted tracks.
//  2. src/lib/cobalt.ts derives a thumbnail URL for supported sources (YouTube/TikTok)
//     so the fallback has art to show without extra API keys.
//  3. src/components/PlayerView.tsx streams audio from the audio endpoint directly
//     (progressive playback) instead of blob-fetching the entire file before enabling play.
//  4. src/components/PlayerView.tsx download is a direct anchor to the audio endpoint
//     (server sends Content-Disposition), NOT a programmatic .click() on a
//     `display:none` anchor (Chrome drops downloads for hidden anchors).
//  5. src/lib/extract.ts tries the cobalt fallback on general extractor failures too
//     (e.g. TikTok "Unexpected response"), not only bot-block signals.
//  6. src/lib/ytdlp.ts humanizeExtractorError no longer maps TikTok-style
//     "Unexpected response from webpage request" to the misleading "ffmpeg missing" message.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extract = resolve(root, "src/lib/extract.ts");
const ytdlp = resolve(root, "src/lib/ytdlp.ts");
const cobalt = resolve(root, "src/lib/cobalt.ts");
const player = resolve(root, "src/components/PlayerView.tsx");

let passed = 0;
let failed = 0;
const pass = (msg) => { console.log("PASS", msg); passed++; };
const fail = (msg) => { console.log("FAIL", msg); failed++; };

// Check 1: cobalt TrackMeta blocks store a thumbnail, not undefined.
if (!existsSync(extract)) {
  fail("src/lib/extract.ts missing (check 1)");
} else {
  const src = readFileSync(extract, "utf8");
  const thumbnailUndefinedCount = (src.match(/thumbnail:\s*undefined/g) || []).length;
  const thumbnailSetCount = (src.match(/thumbnail:\s*[^\s,]+/g) || []).length;
  if (thumbnailUndefinedCount === 0 && thumbnailSetCount >= 2) pass("extract.ts cobalt blocks set thumbnail (no undefined)");
  else fail(`extract.ts cobalt thumbnail not set (undefined=${thumbnailUndefinedCount}, set=${thumbnailSetCount})`);
}

// Check 2: cobalt.ts derives a thumbnail URL.
if (!existsSync(cobalt)) {
  fail("src/lib/cobalt.ts missing (check 2)");
} else {
  const src = readFileSync(cobalt, "utf8");
  if (/i\.ytimg\.com|thumbnail|thumb/i.test(src)) pass("cobalt.ts derives/provides a thumbnail URL");
  else fail("cobalt.ts has no thumbnail derivation");
}

// Check 3: player streams audio from the endpoint (progressive) rather than gating on blob.
if (!existsSync(player)) {
  fail("src/components/PlayerView.tsx missing (check 3)");
} else {
  const src = readFileSync(player, "utf8");
  // Audio element src must point at the endpoint URL, and play must not wait on a blob fetch.
  const audioSrcIsEndpoint = /<audio[\s\S]{0,200}src=\{?\s*[`"]?\/api\/audio\/\$\{meta\.id\}/.test(src)
    || /audioUrl[\s\S]{0,60}api\/audio\/\$\{meta\.id\}/.test(src)
    || /const\s+audioUrl[\s\S]{0,120}api\/audio\/\$\{meta\.id\}/.test(src)
    || /audioSrc[\s\S]{0,80}api\/audio\/\$\{meta\.id\}/.test(src);
  const blobUrlForAudio = /createObjectURL\(blob\)[\s\S]{0,60}setAudioUrl/.test(src) || /URL\.createObjectURL\([\s\S]{0,60}audioUrl/.test(src);
  if (audioSrcIsEndpoint && !blobUrlForAudio) pass("PlayerView streams audio from /api/audio/{id}");
  else fail(`PlayerView still gates play on full blob fetch (endpoint=${audioSrcIsEndpoint}, blobUrlForAudio=${blobUrlForAudio})`);
}

// Check 4: download is a direct anchor to the audio endpoint.
if (!existsSync(player)) {
  fail("src/components/PlayerView.tsx missing (check 4)");
} else {
  const src = readFileSync(player, "utf8");
  const directDownload = /href=\{?\`?\/api\/audio\/\$\{meta\.id\}\`?[^\n]*download/.test(src) || /href=\{?\`?\/api\/audio\/\$\{meta\.id\}\`?/.test(src);
  const displayNoneClick = /display:\s*"none"[\s\S]{0,300}click\(\)/s.test(src) || /\.click\(\)/.test(src);
  if (directDownload && !displayNoneClick) pass("PlayerView download = direct endpoint anchor (no hidden-anchor .click)");
  else fail("PlayerView download still uses hidden-anchor programmatic click");
}

// Check 5: cobalt fallback covers general extractor failures (not only bot blocks).
if (!existsSync(extract)) {
  fail("src/lib/extract.ts missing (check 5)");
} else {
  const src = readFileSync(extract, "utf8");
  // Accept either the original 3 direct call sites OR the DRY helper
  // (tryCobaltFallback) that wraps getCobaltAudio + writeCobaltTrack; the
  // helper must be invoked from the general failure path, not only behind the
  // isBotBlockError gate.
  const helperUsed = /tryCobaltFallback\(/.test(src) && !/isBotBlockError[\s\S]{0,40}getCobaltAudio\(url\)/.test(src);
  const directCalls = (src.match(/getCobaltAudio\(url\)/g) || []).length >= 3;
  const generalFailure = /tryCobaltFallback\(url,\s*id,\s*mp3Path\)/.test(src) || /getCobaltAudio\(url\)[\s\S]{0,80}catch/.test(src);
  if ((directCalls || helperUsed) && generalFailure)
    pass("extract.ts tries cobalt on general failures (helper or >=3 call sites, not only bot gate)");
  else fail(`extract.ts cobalt coverage insufficient (helper=${helperUsed}, directCalls=${directCalls}, general=${generalFailure}))`);
}

// Check 6: TikTok "Unexpected response" not mapped to ffmpeg-missing.
if (!existsSync(ytdlp)) {
  fail("src/lib/ytdlp.ts missing (check 6)");
} else {
  const src = readFileSync(ytdlp, "utf8");
  const ffmpegPattern = /\/ffmpeg\|avconv\/i[\s\S]{0,80}\/not found\|not installed\|missing\|could not\|failed\/i/;
  const tiktokMappedToFfmpeg = ffmpegPattern.test(src) && /unexpected response/i.test(src) && /ffmpeg[\s\S]{0,80}unexpected response/.test(src);
  if (!tiktokMappedToFfmpeg && /unexpected response/i.test(src)) pass("humanizeExtractorError handles TikTok 'Unexpected response' (not ffmpeg-missing)");
  else fail("humanizeExtractorError still maps TikTok extractor errors to ffmpeg-missing");
}

console.log(`\n[verify-player-fixes] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
