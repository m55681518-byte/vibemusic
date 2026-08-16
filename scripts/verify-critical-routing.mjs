// Acceptance gate: "critical Android-share extraction hardening"
// (freebuff-task-20260816-231456).
//
// Override requirements:
//   1. Case-INSENSITIVE URL regex in /api/extract (Android share capitalizes
//      the scheme: "Https://..."). extract.ts already uses /gi + normalizeUrl
//      /^https?:\/\//i — the guards below PIN that behavior (non-regression).
//   2. Cobalt fallback must loop through the whole instance pool when an
//      instance answers 403 / 429 / 500 and the error label must carry the
//      HTTP status (so the UI can say "Cobalt 403", not a bare message).
//   3. The cobalt audio download MUST send spoofed browser headers
//      (User-Agent, Referer, Accept) and the server-side integrity gates
//      (size>0 + valid ffprobe duration) must survive.
//   4. /api/extract passes the exact error string to the frontend, and the
//      frontend error UI MUST render that exact string VISIBLY (not only
//      hidden inside a closed <details>).
//
// The GB checks FAIL against a91c2d4; the fix must make them PASS.
// GP checks are regression guards and must stay PASS.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const files = {
  extractLib: resolve(root, "src/lib/extract.ts"),
  cobalt: resolve(root, "src/lib/cobalt.ts"),
  extractRoute: resolve(root, "src/app/api/extract/route.ts"),
  extractPage: resolve(root, "src/app/extract/page.tsx"),
};

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };
const src = (name) => {
  const p = files[name];
  if (!existsSync(p)) { fail(`${name}: file missing`); return ""; }
  return readFileSync(p, "utf8");
};

// ---- G1 (guard): case-insensitive URL regex survives -----------------------
{
  const s = src("extractLib");
  const urlLine = (s.split("\n").find((l) => l.includes("URL_IN_TEXT") && /const\s+URL_IN_TEXT\s*=/.test(l)) || "");
  const hasIFlag = /\/gi\s*;|\/[a-z]*i[a-z]*\s*;/.test(urlLine);
  if (hasIFlag) pass("G1: URL regex keeps the case-insensitive `i` flag");
  else fail("G1: URL regex `i` flag missing");
}

// ---- G1b (guard): normalizeUrl accepts an uppercase scheme (Https://) -------
{
  const s = src("extractLib");
  const block = s.slice(s.indexOf("normalizeUrl"), s.indexOf("normalizeUrl") + 400);
  const schemeRe = /\^https\?\s*:\s*\\\/\\\//.test(block) && /i\.test/.test(block);
  if (schemeRe) pass("G1b: normalizeUrl scheme check is case-insensitive");
  else fail("G1b: normalizeUrl scheme check not case-insensitive");
}

// ---- G2 (guard): full-URL extraction survives (share-sheet captions) --------
{
  const s = src("extractLib");
  const firstUrl = /extractValidUrl|extractFirstUrl|matchAll\(/.test(s);
  const applied = /extractValidUrl\(\s*raw/.test(src("extractRoute")) ||
    /extractValidUrl\(\s*(?:String\(\s*)?body\??\.url/.test(src("extractRoute"));
  if (firstUrl && applied) pass("G2: first-valid-URL extraction applied in /api/extract");
  else fail(`G2: URL extraction not applied (firstUrl=${firstUrl}, applied=${applied})`);
}

// ---- GB3 (new): cobalt audio download sends spoofed browser headers ---------
{
  const s = src("extractLib");
  const inCobaltTrack = s.slice(s.indexOf("writeCobaltTrack"), s.indexOf("tryCobaltFallback")).includes("fetch(cobalt.audioUrl");
  const downloadSec = s.slice(s.indexOf("writeCobaltTrack"), s.indexOf("tryCobaltFallback"));
  const hasUa = /User-Agent["']?\s*:/.test(downloadSec) || /userAgent/.test(downloadSec);
  const hasReferer = /Referer["']?\s*:/.test(downloadSec) || /referer/.test(downloadSec);
  const hasAccept = /Accept["']?\s*:/.test(downloadSec) || /accept\s*:/.test(downloadSec);
  const spoof = hasUa && (hasReferer || hasAccept);
  if (spoof && inCobaltTrack) pass("GB3: cobalt audio download sends User-Agent + Referer/Accept");
  else fail(`GB3: no spoofed browser headers on cobalt download (ua=${hasUa}, referer=${hasReferer}, accept=${hasAccept}, inCobaltTrack=${inCobaltTrack})`);
}

// ---- GB4 (new): cobalt error labels carry the HTTP status (403/429/500) ----
{
  const c = src("cobalt");
  const statusCaptured = /res\.status/.test(c) || /response\.status/.test(c) || /`Cobalt [a-z]+ (?:failed|HTTP)\s*\$?\s*\{\s*(?:res|response)\.status/i.test(c);
  const loopsPool = (c.match(/[[(]COBALT_INSTANCES|for\s*\([^)]*(?:instance|base|host|entry)[^)]*\)/) || []).length >= 1;
  const skipsBad = /res\.ok/.test(c) || /status === "tunnel"/.test(c) || /body\.status/.test(c);
  if (statusCaptured && loopsPool && skipsBad) pass("GB4: cobalt surfaces HTTP status in errors and loops the full pool");
  else fail(`GB4: cobalt status capture/pool-loop missing (status=${statusCaptured}, pool=${loopsPool}, skip=${skipsBad})`);
}

// ---- GB4b (new): cobalt request also carries browser-like Accept ------------
{
  const c = src("cobalt");
  const acceptJson = /Accept\s*:/.test(c) && /application\/json/.test(c);
  const uaCobalt = /User-Agent/.test(c);
  if (acceptJson) pass("GB4b: cobalt API request sends Accept: application/json");
  else fail("GB4b: cobalt API request missing Accept header");
  if (uaCobalt) pass("GB4c: cobalt API request sends a User-Agent");
  else fail("GB4c: cobalt API request missing User-Agent");
}

// ---- GP5 (guard): server-side integrity gates survive (size>0 + ffprobe) ----
{
  const s = src("extractLib");
  const sizeGuard = /!?buffer\.length/ .test(s) && /0 bytes|yielded 0 bytes|if \(!buffer\.length\)/.test(s);
  const probe = /probeAudioDuration\s*\(/.test(s) && /=== null|\+\+\s*/.test(s);
  const probeNull = /probeAudioDuration\s*\([\s\S]{0,200}=== null/.test(s);
  if (sizeGuard && probeNull) pass("GP5: downloaded file asserted size>0 AND ffprobe-verified before persisting");
  else fail(`GP5: size/ffprobe assert missing (size=${sizeGuard}, probe=${probeNull})`);
}

// ---- GP6 (guard): no local yt-dlp execution on the extract path -------------
{
  const s = src("extractLib");
  const usesLocal = /getMediaInfo\(/.test(s) || /extractAudioToFile\(/.test(s);
  if (!usesLocal) pass("GP6: extract path stays 100% external (no local yt-dlp execution)");
  else fail("GP6: local yt-dlp execution reintroduced on extract path");
}

// ---- GB7 (new): /api/extract forwards the EXACT error string ----------------
{
  const r = src("extractRoute");
  const forwardsDetails = /details\s*:\s*String\(\s*(?:err|error|e)\s*\)/.test(r) ||
    /details\s*:\s*(?:err|error|e)\s*instanceof\s+Error/.test(r) ||
    /details\s*:\s*\w+\.message/.test(r);
  const errorField = /error\s*:\s*message/.test(r) || /error\s*:\s*(?:err|error|e)\s*[),]/.test(r) ||
    /error\s*:\s*(?:err|error|e) instanceof/.test(r);
  const exactString = (/error\s*:\s*message\s*,?\s*details\s*:\s*String\(\s*(?:err|error|e)\s*\)/.test(r)) ||
    (/error\s*:[^,]{1,60}details\s*:[^}]{1,80}/.test(r) && forwardsDetails);
  if (exactString && errorField) pass("GB7: /api/extract returns the exact error string");
  else fail(`GB7: exact error string not returned (forwards=${forwardsDetails}, errorField=${errorField}, exact=${exactString})`);
}

// ---- GB8 (new): frontend renders the exact error string VISIBLY -------------
// The override demands the exact string visible without opening the <details>.
// Baseline only renders it inside a collapsed <details> — must become visible.
{
  const p = src("extractPage");
  const messageShown = /<p>\{phase\.message\}/.test(p) || /<p[^>]*>\{phase\.message/.test(p);
  // The exact `details` string must be visible WITHOUT interaction: either a
  // visible <p> paragraph, or a <details> forced open (open={{nbsp}}true).
  const visibleP = /<p[^>]*>\{\s*phase\.details\s*\}|<p>\{phase\.details\}/.test(p);
  const alwaysOpen = /<details[^>]*\sopen\s*=\s*\{\s*true\s*\}/.test(p) ||
    /<details[^>]*\sopen/.test(p);
  const inSummary = /<summary[^>]*>\{\s*phase\.details\s*\}/.test(p);
  if (messageShown && (visibleP || alwaysOpen)) pass("GB8: exact error string rendered visibly (paragraph or forced-open)");
  else fail(`GB8: exact string still hidden in a collapsed <details> (message=${messageShown}, visibleP=${visibleP}, alwaysOpen=${alwaysOpen}, inSummary=${inSummary})`);
}

console.log(`\n[verify-critical-routing] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);