#!/usr/bin/env node
/**
 * Acceptance gate: whisper.ts GETS FAST, KEYED TIERS (Puter + Groq-first).
 *
 * User gave free tokens for BOTH Groq (whisper-large-v3-turbo on Groq's LPU:
 * sub-second on 20s clips) and Puter (user-pays, keyless-to-dev). Tier 2 must
 * try the fastest keyed backend FIRST (Groq), then Puter, then keep the
 * zero-key parallel Gradio race as the no-credential fallback. The module
 * contract is fixed: no throw, per-space 14000 race, total 15000 budget,
 * parallel Promise.any spaces, whisperTranscribe export — all still enforced
 * by the adjacent gates (verify-gradio-timeout, verify-gradio-whisper,
 * verify-original-sound-identify). This gate adds the PUTER tier + order.
 *
 * USAGE: node scripts/verify-puter-tier.mjs   (expect 17/17 PASS after fix)
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const whisperSrc = readFileSync(path.join(root, "src", "lib", "whisper.ts"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");

let passed = 0;
let failed = 0;
function pass(name) {
  passed++;
  console.log(`PASS ${name}`);
}
function fail(name) {
  failed++;
  console.log(`FAIL ${name}`);
}

// --- GP1: Puter tier exists and is env-gated ---------------------------------
if (/function\s+puterTranscribe|const\s+puterTranscribe/.test(whisperSrc))
  pass("GP1: puter tier function present in whisper.ts");
else fail("GP1: puter tier function missing in whisper.ts");

if (/function\s+puterApiToken/.test(whisperSrc))
  pass("GP1b: puterApiToken() helper reads env");
else fail("GP1b: no puterApiToken() helper");

if (/PUTER_AUTH_TOKEN\s*\|\|\s*\w+|AI_PUTER_TOKEN\s*\|\|\s*\w+/.test(whisperSrc))
  pass("GP1c: token fetched from PUTER_AUTH_TOKEN or AI_PUTER_TOKEN (fallthrough, never throws)");
else fail("GP1c: no token env read in whisper.ts");

if (/if\s*\(!\s*puterToken\)\s*return\s+null/.test(whisperSrc))
  pass("GP1d: puter tier short-circuits to null when no token configured");
else fail("GP1d: puter tier does not short-circuit without a token");

// --- GP2: Puter tier actually calls Puter (init + speech2txt) -----------------
if (/await\s+import\(["']@heyputer\/puter\.js\/src\/init\.cjs["']\)/.test(whisperSrc))
  pass("GP2: puter tier dynamically imports init from @heyputer/puter.js/src/init.cjs");
else fail("GP2: no dynamic import of the puter init module");

if (/\binit\s*\(/.test(whisperSrc) && /puter\.ai\.speech2txt|ai\.speech2txt/.test(whisperSrc))
  pass("GP2b: puter tier init()s Puter and calls ai.speech2txt");
else fail("GP2b: puter tier does not call init() + ai.speech2txt");

// --- GP3: Tier ORDER — keyed fast tiers first, Gradio zero-key fallback ------
// Order inside runAllTiers(): groq (if key) -> puter (if token) -> gradio race.
const runAllTiersBody = whisperSrc.slice(
  whisperSrc.indexOf("async function runAllTiers"),
  whisperSrc.indexOf("async function transcribeViaGradio"),
);
const groqInBody = runAllTiersBody.indexOf("groqTranscribe");
const puterInBody = runAllTiersBody.indexOf("puterTranscribe");
const gradioInBody = runAllTiersBody.indexOf("transcribeViaGradio");
if (groqInBody !== -1 && gradioInBody !== -1 && groqInBody < gradioInBody)
  pass("GP3: groq tier is tried BEFORE the Gradio spaces tier");
else fail(`GP3: groq before gradio ordering wrong (groq=${groqInBody} gradio=${gradioInBody})`);

if (puterInBody > 0 && gradioInBody > 0 && puterInBody < gradioInBody)
  pass("GP3b: puter tier is tried BEFORE the Gradio spaces tier");
else fail(`GP3b: puter before gradio ordering wrong (puter=${puterInBody} gradio=${gradioInBody})`);

if (/transcribeViaGradio|Promise\.any|Promise\.allSettled/.test(whisperSrc))
  pass("GP3c: zero-key parallel Gradio race still present as fallback");
else fail("GP3c: parallel Gradio race removed");

// --- GP4: constants + no-throw contract intact --------------------------------
if (/PER_SPACE_TIMEOUT_MS\s*=\s*14000/.test(whisperSrc))
  pass("GP4: PER_SPACE_TIMEOUT_MS still 14000");
else fail("GP4: PER_SPACE_TIMEOUT_MS changed");

if (/TOTAL_TIMEOUT_MS\s*=\s*15000/.test(whisperSrc))
  pass("GP4b: TOTAL_TIMEOUT_MS still 15000");
else fail("GP4b: TOTAL_TIMEOUT_MS changed");

if (!/\bthrow\b/.test(whisperSrc))
  pass("GP4c: no throw statements anywhere in whisper.ts (G6c safe)");
else fail("GP4c: throw found in whisper.ts — breaks verify-gradio-whisper G6c");

if (/export\s+async\s+function\s+whisperTranscribe/.test(whisperSrc))
  pass("GP4d: whisperTranscribe export intact");
else fail("GP4d: whisperTranscribe export missing");

// --- GP5: puter tier never throws, resolves null on failure -------------------
if (/async\s+function\s+puterTranscribe/.test(whisperSrc) && /catch\s*\{/.test(whisperSrc))
  pass("GP5: puter tier wrapped in try/catch (never throws)");
else fail("GP5: puter tier has no try/catch guard");

if (/return\s+null/.test(whisperSrc) && /\{\s*synced:\s*null,\s*plain:\s*null,\s*isInstrumental:\s*true\s*\}/.test(whisperSrc))
  pass("GP5b: null / instrumental result reset paths present");
else fail("GP5b: no null/instrumental result path in whisper.ts");

// --- GP6: dependency + Docker node 24 (puter-js REQUIRES node >= 24) ----------
if (pkg.dependencies && pkg.dependencies["@heyputer/puter.js"])
  pass("GP6: @heyputer/puter.js declared in package.json dependencies");
else fail("GP6: @heyputer/puter.js missing from package.json");

const node24stages = /\bfrom\s+node:24\S*\s+AS\s+(deps|build|runner)/gi.test(dockerfile);
const allStages = (dockerfile.match(/\bFROM\s+node:\S+/gi) || []).length;
if (/node:24/.test(dockerfile) && dockerfile.match(/\bFROM\s+node:\S+/gi)?.every((f) => /node:24/.test(f)))
  pass(`GP6b: Dockerfile staged on node:24 (all ${allStages} FROM stages)`);
else fail(`GP6b: Dockerfile not fully on node:24 (stages=${allStages}, node24=${node24stages})`);

// --- GP7: identify integration must not regress --------------------------------
if (readFileSync(path.join(root, "src", "lib", "extract.ts"), "utf8").includes("identifyTrackFromAudio"))
  pass("GP7: extract.ts still imports identifyTrackFromAudio (no regression)");
else fail("GP7: extract.ts identify import lost");

if (/whisper-large-v3-turbo/.test(whisperSrc))
  pass("GP7b: hf-audio/whisper-large-v3-turbo still in the space list");
else fail("GP7b: turbo space removed from space list");

console.log(`\n[verify-puter-tier] ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);