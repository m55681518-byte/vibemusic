// Acceptance gate: bounded cobalt fallback retry (freebuff-task-20260816-152441).
//
// WHY: the cobalt fallback returns tunnels that often contain 0 bytes (the
// empty-tunnel bug) with no retry — if all instances yield empty bodies at the
// same moment, a valid track (e.g. https://music.youtube.com/watch?v=SMTWfzEOXC4)
// fails with a 422 even though cobalt works minutes later. Add a BOUNDED retry
// loop with backoff around the whole cobalt attempt (query + download) so a
// transient empty-tunnel window doesn't fail the request.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const file = resolve(root, "src/lib/extract.ts");
const src = existsSync(file) ? readFileSync(file, "utf8") : "";

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

// G1. A named, bounded max-attempts constant exists for cobalt.
const g1 = /COBALT_MAX_ATTEMPTS\s*=\s*\d+\s*;/.test(src);
if (g1) pass("G1: cobalt retry has a bounded max-attempts constant");
else fail("G1: no COBALT_MAX_ATTEMPTS (or similar) constant");

// G2. The cobalt attempt happens inside a retry loop (for/while) that repeats.
const g2 = /for\s*\([\s\S]{0,120}COBALT_MAX_ATTEMPTS[\s\S]{0,600}/.test(src) ||
  /while\s*\([\s\S]{0,120}COBALT_MAX_ATTEMPTS/.test(src) ||
  /attempt\s*[<≤]\s*COBALT_MAX_ATTEMPTS/.test(src);
if (g2) pass("G2: cobalt attempt wrapped in a retry loop bounded by the constant");
else fail("G2: cobalt attempt not wrapped in a bounded retry loop");

// G3. There is a backoff/delay between retry attempts.
const g3 = /await\s+(sleep|delay|wait|setTimeout)[\s\S]{0,120}attempt/.test(src) ||
  /sleep\s*\(\s*COBALT_RETRY_BACKOFF_MS/.test(src) ||
  /COBALT_RETRY_BACKOFF_MS[\s\S]{0,80}attempt/.test(src) ||
  /await\s+sleep\s*\(\s*\d+\s*[\s\S]{0,80}attempt/.test(src);
if (g3) pass("G3: backoff delay between retry attempts");
else fail("G3: no backoff delay between retry attempts");

// G4. Retry loop is bounded (not while(true)/for(;;)).
const g4 = !/while\s*\(\s*true\s*\)/.test(src) && !/for\s*\(\s*;\s*;\s*\)/.test(src);
if (g4) pass("G4: retry loop is bounded (no infinite loop)");
else fail("G4: retry loop appears unbounded");

// G5. The yt-dlp primary path still runs BEFORE cobalt fallback in doExtract.
const first = src.indexOf("extractAudioToFile");
const cobaltCall = src.indexOf("getCobaltAudio");
if (cobaltCall === -1) fail("G5: cobalt fallback call not found");
else if (first !== -1 && first < cobaltCall) pass("G5: yt-dlp primary path precedes cobalt fallback");
else fail("G5: cobalt fallback appears before the yt-dlp primary path");

// G6. The cobalt fallback is attempted at least as many times as the constant allows.
const g6 = /COBALT_MAX_ATTEMPTS\s*=\s*(\d+)\s*;/.exec(src);
if (g6 && parseInt(g6[1], 10) >= 2) pass("G6: COBALT_MAX_ATTEMPTS >= 2 (allows a real retry)");
else fail("G6: COBALT_MAX_ATTEMPTS is 1 or missing (no real retry)");

console.log(`\n[verify-cobalt-retry] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);