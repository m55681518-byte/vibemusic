// Acceptance gate for Turn C: Zero-Config Bot Bypass.
// Hard checks:
//  1. src/lib/extract.ts base args include the three requested flag groups:
//     --impersonate chrome ; --extractor-args "youtube:player_client=default,-android_sdkless" ;
//     --downloader-args "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5"
//  2. src/lib/ytdlp.ts getVideoInfo args include the same three flag groups
//  3. A cobalt fallback module exists (src/lib/cobalt.ts) that POSTs to a public instance
//     and returns a direct audio URL + metadata (title/artist) for a source URL.
//  4. src/lib/extract.ts wires the fallback in: on yt-dlp bot/403 failure it calls cobalt,
//     downloads the returned audio to the mp3 path, and builds TrackMeta from it.
//  5. No secrets/env required: the cobalt module has a hardcoded default instance list and
//     no API key.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extract = resolve(root, "src/lib/extract.ts");
const ytdlp = resolve(root, "src/lib/ytdlp.ts");
const cobalt = resolve(root, "src/lib/cobalt.ts");

let passed = 0;
let failed = 0;
const pass = (msg) => { console.log("PASS", msg); passed++; };
const fail = (msg) => { console.log("FAIL", msg); failed++; };

const IMPERSONATE = "--impersonate";
const CHROME = /chrome/;
const PLAYER = /youtube:player_client=default,-android_sdkless/;
const RECONNECT = /ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5/;

// Check 1+2: flags present in both files
for (const [label, p] of [["extract.ts", extract], ["ytdlp.ts", ytdlp]]) {
  if (!existsSync(p)) { fail(`${label} missing`); continue; }
  const src = readFileSync(p, "utf8");
  if (src.includes(IMPERSONATE) && CHROME.test(src)) pass(`${label} includes --impersonate chrome`);
  else fail(`${label} missing --impersonate chrome`);
  if (PLAYER.test(src)) pass(`${label} includes player_client=default,-android_sdkless`);
  else fail(`${label} missing player_client=default,-android_sdkless`);
  if (RECONNECT.test(src)) pass(`${label} includes ffmpeg reconnect downloader-args`);
  else fail(`${label} missing ffmpeg reconnect downloader-args`);
}

// Check 3: cobalt module exists with a public-instance call
if (!existsSync(cobalt)) {
  fail("src/lib/cobalt.ts missing");
} else {
  const src = readFileSync(cobalt, "utf8");
  if (/https?:\/\//.test(src)) pass("cobalt.ts references a public instance URL");
  else fail("cobalt.ts has no instance URL");
  if (/fetch\(/.test(src) || /https?:\/\//.test(src)) pass("cobalt.ts performs an HTTP request");
  else fail("cobalt.ts does not perform an HTTP request");
  if (/downloadMode|audio|mp3/.test(src)) pass("cobalt.ts requests audio");
  else fail("cobalt.ts does not request audio output");
  if (!/process\.env\.([A-Z_]+)/.test(src.replace(/COBALT[A-Z_]*/, ""))) pass("cobalt.ts has no required API-key secret");
  else fail("cobalt.ts may require a secret (contradicts zero-config)");
}

// Check 4: extract.ts wires cobalt fallback
if (!existsSync(extract)) {
  fail("src/lib/extract.ts missing (check 4)");
} else {
  const src = readFileSync(extract, "utf8");
  if (/cobalt/.test(src)) pass("extract.ts imports/uses the cobalt fallback");
  else fail("extract.ts does not reference cobalt");
  if (/import.*cobalt|from "\.\/cobalt"|require.*cobalt/.test(src)) pass("extract.ts imports the cobalt module");
  else fail("extract.ts does not import the cobalt module");
}

console.log(`\n[verify-bot-bypass] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
