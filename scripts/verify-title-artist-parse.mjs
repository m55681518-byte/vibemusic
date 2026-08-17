// Acceptance gate: "YT Music artist-prefix title/artist fix"
// (freebuff-task-20260817133545).
//
// LIVE-REPRO (2026-08-17, verified by session agent on Render):
//   music.youtube.com/watch?v=evny_w98PjI = "Ari Abdul - BABYDOLL (Lyric Video)".
//   Cobalt returns filename "Ari Abdul - BABYDOLL (Lyric Video) - Ari Abdul.mp3"
//   (the video title itself embeds the artist, "Ari Abdul - BABYDOLL (Lyric
//   Video)", plus cobalt appends the trailing artist).
//
// USER SYMPTOM: this kind of song (and many others) shows partial/no lyrics.
//
// ROOT CAUSE (found by session agent, verified live):
// 1. parseTitleArtist (src/lib/cobalt.ts) splits the filename on the FIRST
//    " - " separator: "Ari Abdul" (title) / "BABYDOLL (Lyric Video) - Ari
//    Abdul" (artist) — completely mangled. The saved meta shows
//    title="Ari Abdul", artist="BABYDOLL (Lyric Video) - Ari Abdul".
// 2. cleanTrackMetadata (src/lib/lyrics.ts) does NOT strip a leading
//    "{artist} - " prefix from the title. So even with the correct ID3 tags
//    (title="Ari Abdul - BABYDOLL (Lyric Video)", artist="Ari Abdul") the
//    search key becomes "Ari Abdul - BABYDOLL" and the LRCLIB exact lookup
//    fails, falling back to a fuzzy hit ("Ari Abdul - BABYDOLL", 1317 synced
//    chars) instead of the canonical full record ("Babydoll" by "Ari Abdul",
//    1510 synced chars, first [00:02.83]).
//
// FIX DESIGN (required):
// 1. parseTitleArtist must split on the LAST " - " (artist is the trailing
//    segment) and, when the title part begins with "{artist} - " (case
//    insensitive), strip that artist prefix. For the repro: artist="Ari
//    Abdul", title="BABYDOLL (Lyric Video)". The single-dash and
//    artist-free-title cases must keep working.
// 2. New EXPORTED pure helper `stripArtistTitlePrefix(artist, title)` in
//    src/lib/lyrics.ts: returns the title with a leading "{artist} - " prefix
//    removed (case insensitive, only when the artist is non-empty and the
//    title actually starts with it), else the title unchanged.
// 3. cleanTrackMetadata must call stripArtistTitlePrefix after cleaning so
//    artist="Ari Abdul", title="Ari Abdul - BABYDOLL (Lyric Video)" cleans to
//    title="BABYDOLL", and the LRCLIB exact lookup
//    /get?artist_name=Ari%20Abdul&track_name=BABYDOLL returns the canonical
//    1510-char full synced record.
//
// Expected end state for evny_w98PjI: meta title="BABYDOLL (Lyric Video)",
// artist="Ari Abdul"; LRCLIB exact match serves the full synced lyrics.
//
// GB checks FAIL against baseline e7ea3f3 and PASS after the fix.
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
  // Strip a return-type annotation: either `: Identifier {`, `: { ... } {` or
  // nothing. Handle the object-literal return type used by parseTitleArtist.
  let noRet = after.replace(
    /^\s*:\s*(?:[A-Za-z_$][\w.$]*(?:<[^>]*>)?|\{[^{}]*\})\s*\{/,
    "{",
  );
  if (noRet === after) noRet = after.replace(/:\s*[A-Za-z_$][^\{]*?\{/, "{");
  return code.slice(0, openIdx) + "(" + cleaned.join(", ") + ")" + noRet;
}

function extractFn(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) return null;
  const openParen = src.indexOf("(", i);
  if (openParen < 0) return null;
  // Find the parameter list end (matching close paren), then skip any return
  // type annotation (`: number`, `: Promise<...>`, `: { a: string }`), then
  // the function-body opening brace.
  let depth = 0;
  let j = openParen - 1;
  for (;;) {
    j++;
    if (j >= src.length) return null;
    if (src[j] === "(") depth++;
    else if (src[j] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  // j now at the param-list close paren. Skip whitespace + return type.
  let k = j + 1;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] === ":") {
    k++;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] === "{") {
      // Object-literal return type: skip its balanced braces, then the body `{`.
      let bd = 1;
      k++;
      for (;;) {
        if (k >= src.length) return null;
        if (src[k] === "{") bd++;
        else if (src[k] === "}") {
          bd--;
          if (bd === 0) break;
        }
        k++;
      }
      k++;
      while (k < src.length && /\s/.test(src[k])) k++;
    } else {
      // Scalar/generic return type: scan forward to the body `{`.
      while (k < src.length && src[k] !== "{") k++;
    }
  }
  const open = k;
  if (open >= src.length) return null;
  let bd = 1;
  let m = open;
  for (;;) {
    m++;
    if (m >= src.length) return null;
    if (src[m] === "{") bd++;
    else if (src[m] === "}") {
      bd--;
      if (bd === 0) break;
    }
  }
  return src.slice(i, m + 1);
}

const cobalt = read(resolve(root, "src/lib/cobalt.ts"));
const lyrics = read(resolve(root, "src/lib/lyrics.ts"));

// ---- GB1: parseTitleArtist splits on the LAST " - " and strips artist prefix ----
{
  try {
    const fn = extractFn(cobalt, "function parseTitleArtist");
    if (!fn) throw new Error("parseTitleArtist missing");
    eval(`globalThis.__parse = ${stripTs(fn)}`);
    const p = globalThis.__parse;
    const r = p("Ari Abdul - BABYDOLL (Lyric Video) - Ari Abdul.mp3");
    if (r.title === "BABYDOLL (Lyric Video)" && r.artist === "Ari Abdul") {
      pass(`GB1: parseTitleArtist mangles YT Music artist-prefix filename (title="${r.title}", artist="${r.artist}")`);
    } else {
      fail(`GB1: parseTitleArtist wrong for "Ari Abdul - BABYDOLL (Lyric Video) - Ari Abdul.mp3" (title="${r.title}", artist="${r.artist}")`);
    }
  } catch (e) {
    fail("GB1: could not evaluate parseTitleArtist: " + e.message);
  }
}

// ---- GB2: single-dash filename still parses correctly ----
{
  try {
    const p = globalThis.__parse;
    const r = p("BAILA LENTO (Slowed) - Release.mp3");
    if (r.title === "BAILA LENTO (Slowed)" && r.artist === "Release") {
      pass(`GB2: single-dash filename intact (title="${r.title}", artist="${r.artist}")`);
    } else {
      fail(`GB2: single-dash filename broken (title="${r.title}", artist="${r.artist}")`);
    }
  } catch (e) {
    fail("GB2: could not evaluate parseTitleArtist: " + e.message);
  }
}

// ---- GB3: artist-free title (no artist prefix to strip) stays intact ----
{
  try {
    const p = globalThis.__parse;
    const r = p("Me at the zoo - jawed.mp3");
    if (r.title === "Me at the zoo" && r.artist === "jawed") {
      pass(`GB3: artist-free title intact (title="${r.title}", artist="${r.artist}")`);
    } else {
      fail(`GB3: artist-free title broken (title="${r.title}", artist="${r.artist}")`);
    }
  } catch (e) {
    fail("GB3: could not evaluate parseTitleArtist: " + e.message);
  }
}

// ---- GB4: stripArtistTitlePrefix helper strips leading "{artist} - " ----
{
  try {
    const fn = extractFn(lyrics, "export function stripArtistTitlePrefix");
    if (!fn) throw new Error("stripArtistTitlePrefix helper missing");
    eval(`globalThis.__strip = ${stripTs(fn)}`);
    const strip = globalThis.__strip;
    const r = strip("Ari Abdul", "Ari Abdul - BABYDOLL (Lyric Video)");
    if (r === "BABYDOLL (Lyric Video)") {
      pass(`GB4: stripArtistTitlePrefix strips leading artist prefix (got "${r}")`);
    } else {
      fail(`GB4: stripArtistTitlePrefix should strip leading "Ari Abdul - " (got "${r}")`);
    }
    if (strip("Release", "BAILA LENTO (Slowed)") === "BAILA LENTO (Slowed)") {
      pass("GB4b: stripArtistTitlePrefix leaves unrelated titles untouched");
    } else {
      fail("GB4b: stripArtistTitlePrefix mangled an unrelated title");
    }
  } catch (e) {
    fail("GB4: could not evaluate stripArtistTitlePrefix: " + e.message);
  }
}

// ---- GB5: cleanTrackMetadata wires stripArtistTitlePrefix ----
{
  const fn = extractFn(lyrics, "export function cleanTrackMetadata");
  if (!fn) fail("GB5: cleanTrackMetadata missing");
  else if (/stripArtistTitlePrefix\s*\(/.test(fn)) {
    pass("GB5: cleanTrackMetadata calls stripArtistTitlePrefix after cleaning");
  } else {
    fail("GB5: cleanTrackMetadata does not call stripArtistTitlePrefix");
  }
}

// ---- GP1 (guard): lookups still called with cleaned artist/title in lookupLyrics ----
{
  const lookup = lyrics?.slice(lyrics.indexOf("export async function lookupLyrics")) ?? "";
  const cleans = /cleanTrackMetadata\(/.test(lookup);
  if (cleans) pass("GP1: lookupLyrics still uses cleanTrackMetadata internally");
  else fail("GP1: lookupLyrics no longer cleans metadata");
}

// ---- GP2 (guard): rescaleRatioFor wiring intact (slow-anchor fix) ----
{
  const lookup = lyrics?.slice(lyrics.indexOf("export async function lookupLyrics")) ?? "";
  const usesHelper = /rescaleRatioFor\s*\(/.test(lookup);
  if (usesHelper) pass("GP2: rescaleRatioFor wiring intact");
  else fail("GP2: rescaleRatioFor wiring missing");
}

// ---- GP3 (guard): cobalt download browser headers intact (critical-routing fix) ----
{
  const extract = read(resolve(root, "src/lib/extract.ts")) ?? "";
  const hasUa = /BROWSER_USER_AGENT/.test(extract);
  const hasReferer = /Referer/.test(extract);
  if (hasUa && hasReferer) pass("GP3: cobalt download browser headers intact (extract.ts)");
  else fail(`GP3: cobalt browser headers changed (ua=${hasUa}, referer=${hasReferer})`);
}

console.log(`\n[verify-title-artist-parse] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
