// Acceptance gate: "LRCLIB slowed/speed-shifted sync fix"
// (freebuff-task-20260817-130749).
//
// USER BUG (verged live on ksBrPP45Rms = "BAILA LENTO (Slowed)", audio 94.632s):
// during the instrumental/beat sections the karaoke lyrics keep moving forward.
//
// ROOT CAUSE (verified by the session agent — see journal):
// - lookupLyrics() searches LRCLIB with the CLEANED title ("BAILA LENTO") after
//   cleanTrackMetadata() strips "(Slowed)". rankTitleOnlyHit() gives a +1M bonus
//   to a record whose trackName EXACTLY equals the cleaned title. LRCLIB holds a
//   record literally named "BAILA LENTO" (claimed dur 95) whose synced LRC is in
//   fact timed for the 84s original (first line 0.14s, last 80.26s). That record
//   beats the correct "BAILA LENTO (Slowed)" (dur 95, timed 0.17s..89.96s).
// - The rescale gate then uses ratio = actualDurationSec / lrclib.duration
//   = 94.632 / 95 = 0.9961 → |ratio-1| < 0.02 → NO rescale. The route serves the
//   84-timed LRC against 94.6s of slowed audio → lyrics run ~1.13x too fast and
//   fire during the intro/beat sections.
//
// FIX DESIGN:
// 1. lookupLrclib() must receive the ORIGINAL (uncleaned) title and the title-only
//    fallback must prefer a hit whose trackName matches the ORIGINAL title (the
//    user literally asked for "(Slowed)") over a clean-exact match.
// 2. The rescale ratio must be computed from the LRC's own last timestamp span
//    when available (actualDurationSec / lastTimestamp), falling back to the
//    record's duration only when the span is unknown — so even if only the plain
//    record exists, its timestamps get stretched to the true audio duration.
//
// GB checks FAIL against baseline 5d3d66a and must PASS after the fix.
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
  // find the matching ")" for the parameter list (balanced parens)
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
  // split params on top-level commas (respecting <>, (), [], {})
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
    // remove optional marker on the name
    // find the first top-level ':' of the annotation
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
  // strip return type: after the close paren, drop ": Type" up to "{"
  const after = code.slice(closeIdx + 1);
  const noRet = after.replace(/:\s*[A-Za-z_$][^\{]*?\{/, "{");
  return code.slice(0, openIdx) + "(" + cleaned.join(", ") + ")" + noRet;
}

const lyrics = read(resolve(root, "src/lib/lyrics.ts"));
if (!lyrics) {
  fail("lyrics.ts missing");
} else {
  // ---- GB1: rankTitleOnlyHit must prefer a hit matching the ORIGINAL title ---
  try {
    const fn = extractFn(lyrics, "function rankTitleOnlyHit");
    eval(`globalThis.__rank = ${stripTs(fn)}`);
    const rank = globalThis.__rank;
    const cleanHit = { trackName: "BAILA LENTO", syncedLyrics: "x", duration: 95 };
    const slowedHit = { trackName: "BAILA LENTO (Slowed)", syncedLyrics: "x", duration: 95 };
    const scoreClean = rank(cleanHit, "baila lento", undefined, "baila lento (slowed)");
    const scoreSlowed = rank(slowedHit, "baila lento", undefined, "baila lento (slowed)");
    if (scoreSlowed > scoreClean) pass("GB1: (Slowed)-title hit outranks clean-exact hit when original title says (Slowed)");
    else fail(`GB1: ranking does NOT prefer original-title match (clean=${scoreClean}, slowed=${scoreSlowed})`);
  } catch (e) {
    fail("GB1: could not evaluate rankTitleOnlyHit: " + e.message);
  }

  // ---- GB2: rescaleLrc works and stretch is correct for the BAILA case ---------
  try {
    const tagMatch = lyrics.match(/const LRC_TIME_TAG\s*=\s*\/[^\n]*\/;?/);
    const tagDecl = tagMatch ? tagMatch[0] : "";
    const fn = extractFn(lyrics, "export function rescaleLrc");
    eval(`${tagDecl}\nglobalThis.__rescale = ${stripTs(fn)}`);
    const rescale = globalThis.__rescale;
    const times = [0.14, 2.57, 5.58, 9.85, 11.66, 14.16, 80.26];
    const lrc = times.map((t) => `[00:00.${String(Math.round((t % 1) * 1000)).padStart(3, "0")}] line`).join("\n");
    const spanRatio = 94.632 / 80.26; // actual audio / LRC last timestamp
    const scaled = rescale(lrc, spanRatio);
    const first = (Number(scaled.match(/^\[00:00\.(\d{3})/)?.[1] ?? "0") / 1000).toFixed(3);
    const last = (Number(scaled.match(/\[00:00\.(\d{3})\] line\s*$/)?.[1] ?? "0") / 1000).toFixed(3);
    if (Math.abs(Number(first) - 0.165) < 0.02) pass(`GB2: rescaleLrc span-ratio yields first line ${first}s (~0.165 expected)`);
    else fail(`GB2: rescaleLrc result wrong (first=${first})`);
  } catch (e) {
    fail("GB2: could not evaluate rescaleLrc: " + e.message);
  }

  // ---- GB3: lookupLyrics must compute rescale ratio from LRC span ------------
  try {
    const lookup = lyrics.slice(lyrics.indexOf("export async function lookupLyrics"));
    const spanAbsent = /span\s*=\s*lastTimestamp|lastTimestamp\s*\|\|\s*lrclib\.duration|const\s+span/.test(lookup);
    const ratioSpan = /actualDurationSec\s*\/\s*(?:lastTimestamp|span|candidateLast|maxTime|lastTime)/i.test(lookup);
    const ratioDur = /actualDurationSec\s*\/\s*(?:lastTimestamp|span|lrclib\.duration|recordDuration)/i.test(lookup);
    const rescaleCalled = /rescaleLrc\s*\(/.test(lookup);
    if (spanAbsent && ratioSpan && rescaleCalled && ratioDur) pass("GB3: lookupLyrics rescale uses LRC span with record-duration fallback");
    else fail(`GB3: span-based rescale not wired (spanAbsent=${spanAbsent}, ratioSpan=${ratioSpan}, ratioDur=${ratioDur}, rescale=${rescaleCalled})`);
  } catch (e) {
    fail("GB3: could not inspect lookupLyrics: " + e.message);
  }
}

// ---- GP4 (guard): buildLrc gap rule unchanged (>5s, marker at end+0.5) ----
{
  const threshold = /next\.start\s*-\s*caption\.end\s*>\s*5/.test(lyrics ?? "");
  const marker = /caption\.end\s*\+\s*0\.5/.test(lyrics ?? "");
  if (threshold && marker) pass("GP4: buildLrc gap rule intact (>5s, ♪ at end+0.5s)");
  else fail(`GP4: buildLrc gap rule changed (threshold=${threshold}, marker=${marker})`);
}

// ---- GP5 (guard): whisper sync fix intact (no end := start) ----
{
  const whisper = read(resolve(root, "src/lib/whisper.ts")) ?? "";
  const bad = /end:\s*line\.timeInSeconds/.test(whisper) || /end:\s*seg\.start/.test(whisper);
  if (!bad) pass("GP5: whisper seg.end preservation intact");
  else fail("GP5: whisper end := start regression");
}

// ---- GP6 (guard): PlayerView karaoke driver untouched ----
{
  const player = read(resolve(root, "src/components/PlayerView.tsx")) ?? "";
  const timeupdate = player.includes('addEventListener("timeupdate"');
  const findActive = /synced\[i\]\.time\s*<=\s*audio\.currentTime/.test(player);
  if (timeupdate && findActive) pass("GP6: PlayerView timeupdate→findActive sync intact");
  else fail(`GP6: PlayerView sync driver changed (timeupdate=${timeupdate}, findActive=${findActive})`);
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

console.log(`\n[verify-slowed-lrclib] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);