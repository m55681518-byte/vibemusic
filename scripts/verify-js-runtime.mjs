// Acceptance gate: yt-dlp JS runtime fix (freebuff-task-20260816-145541).
//
// WHY: Render's yt-dlp (latest from GitHub releases) has NO JavaScript runtime
// enabled by default (only "deno" is on by default, and the node:20-slim image
// ships node, not deno). Without a JS runtime, yt-dlp cannot solve YouTube's
// nsig/signature challenges, so getMediaInfo/downloads fail on datacenter IPs
// ("Sign in to confirm you're not a bot", missing formats, JS-runtime
// deprecation warning) and the whole request falls back to cobalt — which can
// also fail transiently, producing the live 422 the user hit for
// https://music.youtube.com/watch?v=SMTWfzEOXC4.
//
// Local verification (vendor/yt-dlp.exe 2026.07.04, node available) proved:
//   --js-runtimes node
// cleans the deprecation warning and parse fails clean. Node is guaranteed on
// Render (the app runs on node:20-slim), so the fix is to pass
// --js-runtimes node to EVERY yt-dlp invocation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const ytdlp = readFileSync(resolve(root, "src/lib/ytdlp.ts"), "utf8");
const extract = readFileSync(resolve(root, "src/lib/extract.ts"), "utf8");

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

// G1. getMediaInfo passes --js-runtimes node.
const g1 = /getMediaInfo[\s\S]{0,400}--js-runtimes[\s\S]{0,80}["']node["']/.test(ytdlp);
if (g1) pass("G1: getMediaInfo passes --js-runtimes node");
else fail("G1: getMediaInfo is missing --js-runtimes node");

// G2. downloadAutoCaptions passes --js-runtimes node.
const g2 = /downloadAutoCaptions[\s\S]{0,800}--js-runtimes[\s\S]{0,80}["']node["']/.test(ytdlp);
if (g2) pass("G2: downloadAutoCaptions passes --js-runtimes node");
else fail("G2: downloadAutoCaptions is missing --js-runtimes node");

// G3. extract.ts is 100% external — the js-runtime flag lives in ytdlp.ts
// (both getMediaInfo and downloadAutoCaptions), NOT extract base[].
const g3 = /--js-runtimes[\s\S]{0,80}["']node["']/.test(ytdlp);
if (g3) pass("G3: ytdlp.ts carries --js-runtimes node");
else fail("G3: ytdlp.ts is missing --js-runtimes node");

// G4. Exactly 2 sites in ytdlp.ts (getMediaInfo + downloadAutoCaptions), 0 in extract.
const g4 = (ytdlp.match(/--js-runtimes/g) || []).length === 2 && (extract.match(/--js-runtimes/g) || []).length === 0;
if (g4) pass("G4: --js-runtimes at exactly 2 yt-dlp sites in ytdlp.ts (0 in extract.ts)");
else fail("G4: expected --js-runtimes at exactly 2 sites in ytdlp.ts / 0 in extract.ts, found " +
  `(ytdlp=${(ytdlp.match(/--js-runtimes/g) || []).length}, extract=${(extract.match(/--js-runtimes/g) || []).length})`);

// G5. Existing impersonation / player-client hardening is preserved
// (generic `chrome` shorthand, journal 016 — curl_cffi bundles latest Chrome).
const g5a = /--impersonate[\s\S]{0,40}["']chrome["']/.test(ytdlp);
const g5b = /player_client=(?:default,-android_sdkless|android|tv)/.test(ytdlp + extract);
if (g5a && g5b) pass("G5: impersonate chrome + player_client hardening preserved");
else fail(`G5: impersonation/player_client regressed (impersonate=${g5a}, player_client=${g5b})`);

console.log(`\n[verify-js-runtime] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);