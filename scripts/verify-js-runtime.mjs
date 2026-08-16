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

// G3. The extract download base[] array passes --js-runtimes node.
const g3 = /const\s+base\s*:\s*string\[\][\s\S]{0,600}--js-runtimes[\s\S]{0,80}["']node["']/.test(extract);
if (g3) pass("G3: extract base[] passes --js-runtimes node");
else fail("G3: extract base[] is missing --js-runtimes node");

// G4. Every tainted yt-dlp spawn got the flag (exactly 3 sites expected).
const g4 = (ytdlp.match(/--js-runtimes/g) || []).length + (extract.match(/--js-runtimes/g) || []).length === 3;
if (g4) pass("G4: --js-runtimes present at all 3 yt-dlp invocation sites");
else fail("G4: expected --js-runtimes at exactly 3 sites, found " +
  ((ytdlp.match(/--js-runtimes/g) || []).length + (extract.match(/--js-runtimes/g) || []).length));

// G5. Existing impersonation / player-client hardening is preserved.
const g5a = /--impersonate[\s\S]{0,60}["']chrome["']/.test(ytdlp);
const g5b = /player_client=default,-android_sdkless/.test(ytdlp + extract);
if (g5a && g5b) pass("G5: impersonate chrome + player_client hardening preserved");
else fail(`G5: impersonation/player_client regressed (impersonate=${g5a}, player_client=${g5b})`);

console.log(`\n[verify-js-runtime] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);