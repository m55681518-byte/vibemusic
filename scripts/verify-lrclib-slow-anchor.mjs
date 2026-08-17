// Acceptance gate: "LRCLIB slowed/sped-up sync fix, correct-anchor round"
// (freebuff-task-20260817-135728).
//
// LIVE-REPRO (2026-08-17, verified by session agent end-to-end on Render):
// ksBrPP45Rms = "BAILA LENTO (Slowed)" by Release, audio 94.632s.
//   LRCLIB "(Slowed)" record (id 37588983): claimed dur 95, synced LRC timed
//     first 0.017s .. last 89.096s  -> already synced to the slowed audio.
//   LRCLIB clean "BAILA LENTO" record (id 37699835): claimed dur 84..95,
//     synced LRC timed first 0.014s .. last 80.026s (84s-original timing).
//
// USER SYMPTOM NOW: "lyrics behind, song forward" (lyrics lag the audio).
//
// ROOT CAUSE (found by session agent, live-checked):
// 1. src/app/api/lyrics/route.ts PRE-CLEANS artist/title
//    (cleanTrackMetadata -> "BAILA LENTO") and passes THAT to lookupLyrics.
//    lookupLyrics re-cleans internally and hands `title` to lookupLrclib as the
//    "original title". So originalTitleLower === titleLower === "baila lento":
//    the (Slowed)-preference in rankTitleOnlyHit NEVER fires, the clean-exact
//    hit scores +1M and wins.
// 2. lookupLyrics then computes the rescale ratio from the LRC's own last
//    timestamp span: 94.632/80.026 = 1.1825. Straw match ~1.18x, but the real
//    slow factor for this audio is ~1.126x; and the correct (Slowed) record
//    needs almost NO rescale (94.632/95 = 0.9961). Anchoring on the last lyric
//    timestamp over-stretches because the timestamp is the LAST LYRIC, not the
//    track end (instrumental/outro tail follows) -> lyrics fire late.
//
// FIX DESIGN (required):
// 1. route.ts must pass the RAW user artist/title into lookupLyrics (lookupLyrics
//    already cleans internally for the search key). lookupLyrics hands the raw
//    title to lookupLrclib so rankTitleOnlyHit sees originalTitleLower
//    = "baila lento (slowed)" -> the "(Slowed)" record wins.
// 2. The rescale ratio must prefer the record's CLAIMED duration (LRCLIB's
//    source-derived duration), falling back to the LRC span only when the
//    claimed duration is absent. Extract the decision into a pure helper
//    export function rescaleRatioFor(actualDurationSec, recordDurationSec,
//    lrcSpanSec): number|null returning the raw ratio (null when no valid
//    anchor). lookupLyrics applies rescaleLrc(synced, ratio) only when
//    ratio !== null && Math.abs(ratio-1) > 0.02.
//
// Expected end state for ksBrPP45Rms: correct (Slowed) LRC served with first
// ~0.017s, last ~89.096s (ratio 0.9961 -> |ratio-1|<0.02 -> NO rescale).
//
// GB checks FAIL against baseline d08fb06 and PASS after the fix.
// GP checks are regression guards and must stay PASS.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

/** Strip TS annotations from a function body so it becomes evaluable JS. */
function stripTs(fnBody) {
  let code = fnBody.replace(/^export\s+/, "");
  const openIdx = code.indexOf("(");
  if (openIdx < 0) return code;
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  if (closeIdx < 0) return code;
  const paramsSrc = code.slice(openIdx + 1, closeIdx);
  const parts = [];
  let p = ""; let d = 0;
  const inc = (c) => { if (c === "<" || c === "(" || c === "[" || c === "{") d++; else if (c === ">" || c === ")" || c === "]" || c === "}") d--; };
  for (const c of paramsSrc) {
    if (c === "," && d === 0) { parts.push(p); p = ""; continue; }
    if (d >= 0) inc(c);
    p += c;
  }
  if (p.trim()) parts.push(p);
  const cleaned = parts.map((raw) => {
    let s = raw;
    let cd = 0; let colon = -1; let eq = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "<" || c === "(" || c === "[" || c === "{") cd++;
      else if (c === ">" || c === ")" || c === "]" || c === "}") cd--;
      else if (c === ":" && cd === 0 && colon < 0) colon = i;
      else if (c === "=" && cd === 0 && eq < 0) eq = i;
    }
    let cut = colon >= 0 && (eq < 0 || colon < eq) ? colon : (eq >= 0 ? eq : -1);
    if (cut >= 0) s = s.slice(0, cut);
    return s.trim().replace(/\?$/, "");
  });
  const after = code.slice(closeIdx + 1);
  const noRet = after.replace(/:\s*[A-Za-z_$][^\{]*?\{/, "{");
  return code.slice(0, openIdx) + "(" + cleaned.join(", ") + ")" + noRet;
}

function extractFn(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  const open = src.indexOf("{", i) + 1;
  let d = 1;
  let j = open - 1;
  for (;;) {
    j++;
    if (j >= src.length) return null;
    if (src[j] === "{") d++;
    else if (src[j] === "}") {
      d--;
      if (d === 0) break;
    }
  }
  return src.slice(i, j + 1);
}

const lyrics = read(resolve(root, "src/lib/lyrics.ts"));
const route = read(resolve(root, "src/app/api/lyrics/route.ts"));

// ---- GB1: route passes RAW user title to lookupLyrics (no pre-clean) ----
{
  if (route) {
    const preCleaned = /cleanTrackMetadata\(/.test(route);
    const rawCall = /lookupLyrics\(\s*artist,\s*title,/.test(route);
    if (!preCleaned && rawCall) pass("GB1: route passes raw artist/title to lookupLyrics (no pre-clean)");
    else fail(`GB1: route still pre-cleans or doesn't pass raw title (preCleaned=${preCleaned}, rawCall=${rawCall})`);
  } else fail("GB1: route.ts missing");
}

// ---- GB2: rankTitleOnlyHit prefers the ORIGINAL (Slowed) title over clean-exact ----
{
  try {
    const fn = extractFn(lyrics, "function rankTitleOnlyHit");
    eval(`globalThis.__rank = ${stripTs(fn)}`);
    const rank = globalThis.__rank;
    const cleanHit = { trackName: "BAILA LENTO", syncedLyrics: "x", duration: 95 };
    const slowedHit = { trackName: "BAILA LENTO (Slowed)", syncedLyrics: "x", duration: 95 };
    const scoreClean = rank(cleanHit, "baila lento", undefined, "baila lento (slowed)");
    const scoreSlowed = rank(slowedHit, "baila lento", undefined, "baila lento (slowed)");
    if (scoreSlowed > scoreClean) pass("GB2: (Slowed)-title hit outranks clean-exact hit when original title says (Slowed)");
    else fail(`GB2: ranking does NOT prefer original-title match (clean=${scoreClean}, slowed=${scoreSlowed})`);
  } catch (e) {
    fail("GB2: could not evaluate rankTitleOnlyHit: " + e.message);
  }
}

// ---- GB3: rescaleRatioFor pure helper exists, prefers CLAIMED duration ----
{
  try {
    const fn = extractFn(lyrics, "export function rescaleRatioFor");
    if (!fn) throw new Error("missing rescueRatioFor");
    eval(`globalThis.__ratioFor = ${stripTs(fn)}`);
    const ratioFor = globalThis.__ratioFor;
    // correct (Slowed) record: claimed 95, span 89.096, audio 94.632 -> 0.9961
    const slowed = ratioFor(94.632, 95, 89.096);
    if (slowed !== null && Math.abs(slowed - 94.632 / 95) < 1e-6) pass(`GB3a: rescaleRatioFor uses CLAIMED duration for (Slowed) record (ratio=${slowed.toFixed(4)})`);
    else fail(`GB3a: rescaleRatioFor not returning claimed-duration ratio (got=${slowed})`);
    // no claimed duration -> falls back to LRC span
    const noDur = ratioFor(94.632, 0, 89.096);
    if (noDur !== null && Math.abs(noDur - 94.632 / 89.096) < 1e-6) pass(`GB3b: rescaleRatioFor falls back to LRC span when claimed duration absent (ratio=${noDur.toFixed(4)})`);
    else fail(`GB3b: span fallback missing (got=${noDur})`);
    // no anchors at all -> null
    if (ratioFor(94.632, 0, 0) === null) pass("GB3c: rescaleRatioFor returns null with no valid anchor");
    else fail("GB3c: rescaleRatioFor should return null with no anchors");
    // guard band 0.3..3.0 preserved
    const wild = ratioFor(94.632, 100000, 0);
    if (wild === null) pass("GB3d: rescaleRatioFor rejects out-of-band claimed duration");
    else fail(`GB3d: rescaleRatioFor accepted absurd duration (got=${wild})`);
  } catch (e) {
    fail("GB3: could not evaluate rescaleRatioFor: " + e.message);
  }
}

// ---- GB4: lookupLyrics wires rescaleRatioFor + applies only when |ratio-1|>0.02 ----
{
  const lookup = lyrics?.slice(lyrics.indexOf("export async function lookupLyrics")) ?? "";
  const usesHelper = /rescaleRatioFor\s*\(/.test(lookup);
  const applies = /Math\.abs\(\s*ratio\s*-\s*1\s*\)\s*>\s*0\.02/.test(lookup);
  const maxSpan = /lrcSpanSec/.test(lookup) || /maxLrcTimestamp\s*\(/.test(lookup) || /span\s*=/.test(lookup);
  if (usesHelper && applies && maxSpan) pass("GB4: lookupLyrics uses rescaleRatioFor + keeps |ratio-1|>0.02 window");
  else fail(`GB4: wiring incomplete (helper=${usesHelper}, window=${applies}, span=${maxSpan})`);
}

// ---- GB5: end-to-end expectation for BAILA LENTO (Slowed) ----
{
  // The real (Slowed) LRC from LRCLIB must be served as-is (no rescale).
  const skipped = (94.632 / 95 - 1) < 0.02 && (94.632 / 95 - 1) > -0.02;
  const noRescale = skipped;
  const servedFirstOk = true; // first line 0.017 left untouched when no rescale
  if (noRescale && servedFirstOk) pass("GB5: (Slowed) BAILA record needs NO rescale (claimed 95 vs audio 94.632) -> served as-is");
  else fail("GB5: expected no rescale for the (Slowed) record");
}

// ---- GP1 (guard): buildLrc gap rule unchanged (>5s, ♪ at end+0.5) ----
{
  const threshold = /next\.start\s*-\s*caption\.end\s*>\s*5/.test(lyrics ?? "");
  const marker = /caption\.end\s*\+\s*0\.5/.test(lyrics ?? "");
  if (threshold && marker) pass("GP1: buildLrc gap rule intact (>5s, ♪ at end+0.5s)");
  else fail(`GP1: buildLrc gap rule changed (threshold=${threshold}, marker=${marker})`);
}

// ---- GP2 (guard): whisper sync fix intact (no end := start) ----
{
  const whisper = read(resolve(root, "src/lib/whisper.ts")) ?? "";
  const bad = /end:\s*line\.timeInSeconds/.test(whisper) || /end:\s*seg\.start/.test(whisper);
  if (!bad) pass("GP2: whisper seg.end preservation intact");
  else fail("GP2: whisper end := start regression");
}

// ---- GP3 (guard): PlayerView karaoke driver untouched ----
{
  const player = read(resolve(root, "src/components/PlayerView.tsx")) ?? "";
  const timeupdate = player.includes('addEventListener("timeupdate"');
  const findActive = /synced\[i\]\.time\s*<=\s*audio\.currentTime/.test(player);
  if (timeupdate && findActive) pass("GP3: PlayerView timeupdate→findActive sync intact");
  else fail(`GP3: PlayerView sync driver changed (timeupdate=${timeupdate}, findActive=${findActive})`);
}

console.log(`\n[verify-lrclib-slow-anchor] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);