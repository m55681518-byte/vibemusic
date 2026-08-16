// Acceptance gate: Tier 2 Gradio timeout tuning (freebuff-task-20260816-123000).
//
// User-specified changes to src/lib/whisper.ts:
//   1. PER_SPACE_TIMEOUT_MS must be 14000 (14s) — give the primary space a real
//      chance to return transcription instead of failing over at 5s.
//   2. TOTAL_TIMEOUT_MS must be 15000 (15s) overall request budget (unchanged).
//   3. The FIRST public space in DEFAULT_WHISPER_SPACES must be the primary
//      target and must be one of { hf-audio/whisper-large-v3-turbo,
//      openai/whisper }, receiving the full per-space budget.
//   4. The per-space budget must still be applied per space in the failover
//      loop (Promise.race) and the total budget must still gate the whole tier.
//   5. The legacy acceptance gate scripts/verify-gradio-whisper.mjs must be
//      updated so its per-space timeout check reflects the new 14000 budget
//      (it currently hard-reqs the old 5000 token, which would otherwise regress).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const modFile = resolve(root, "src/lib/whisper.ts");
const oldGateFile = resolve(root, "scripts/verify-gradio-whisper.mjs");

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };
const readMod = existsSync(modFile) ? readFileSync(modFile, "utf8") : "";
const readOld = existsSync(oldGateFile) ? readFileSync(oldGateFile, "utf8") : "";

// G1. Per-space budget is now 14 seconds.
const perSpace = /PER_SPACE_TIMEOUT_MS\s*=\s*(14000|14_000)\s*;/.test(readMod);
if (perSpace) pass("G1: PER_SPACE_TIMEOUT_MS = 14000");
else fail("G1: PER_SPACE_TIMEOUT_MS is not 14000 (still " + (/PER_SPACE_TIMEOUT_MS\s*=\s*\d+/.exec(readMod)?.[0] || "?") + ")");

// G2. Total request budget is 15 seconds.
const total = /TOTAL_TIMEOUT_MS\s*=\s*(15000|15_000)\s*;/.test(readMod);
if (total) pass("G2: TOTAL_TIMEOUT_MS = 15000");
else fail("G2: TOTAL_TIMEOUT_MS is not 15000");

// G3. The primary (first) public space is the intended high-tier target.
const primaryOk =
  /hf-audio\/whisper-large-v3-turbo/.test(readMod) || /openai\/whisper/.test(readMod);
const firstIsPrimary = /["'](hf-audio\/whisper-large-v3-turbo|openai\/whisper)["']\s*,?\s*\n|DEFAULT_WHISPER_SPACES\s*=\s*\[\s*\n?\s*["'](hf-audio\/whisper-large-v3-turbo|openai\/whisper)["']/.test(readMod);
if (primaryOk && firstIsPrimary) pass("G3: primary public space is hf-audio/whisper-large-v3-turbo or openai/whisper, listed first");
else fail(`G3: primary target missing/not first (primaryOk=${primaryOk}, firstIsPrimary=${firstIsPrimary})`);

// G4. Per-space budget is actually applied in the failover loop.
const racePerSpace = /Promise\.race\s*\([\s\S]*PER_SPACE_TIMEOUT_MS/.test(readMod) || /timeoutNull\(\s*PER_SPACE_TIMEOUT_MS\s*\)/.test(readMod);
if (racePerSpace) pass("G4: per-space 14000ms budget applied in the failover loop");
else fail("G4: PER_SPACE_TIMEOUT_MS not wired into a Promise.race/timeout in the space loop");

// G5. Total budget still gates the whole tier.
const raceTotal = /Promise\.race\s*\([\s\S]*TOTAL_TIMEOUT_MS/.test(readMod) || /timeoutNull\(\s*TOTAL_TIMEOUT_MS\s*\)/.test(readMod);
if (raceTotal) pass("G5: TOTAL_TIMEOUT_MS 15000ms gates the whole tier");
else fail("G5: TOTAL_TIMEOUT_MS not wired into the overall race");

// G6. The legacy gate was updated to the new budget (no stale 5000 hard-req).
const staleOld = /\\b5000\\b|\b5_000\b|\b5e3\b/.test(readOld);
const updatedOld = /14000|14_000|PER_SPACE_TIMEOUT_MS/.test(readOld);
if (readOld && !staleOld && updatedOld)
  pass("G6: verify-gradio-whisper.mjs updated to the 14000 per-space budget");
else fail(`G6: legacy gate stale (stale5000=${staleOld}, hasNewBudget=${updatedOld}, file=${existsSync(oldGateFile)})`);

console.log(`\n[verify-gradio-timeout] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);