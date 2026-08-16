// Acceptance gate: "100% external API routing — no local yt-dlp on /api/extract"
// (freebuff-task-20260816-202003).
//
// User problem: Android share sheet sends a SHORTLINK (vt.tiktok.com) wrapped
// in text; TikTok's anti-bot blocks Render's datacenter IP from resolving the
// shortlink → yt-dlp reads a Captcha as "login required" → everything dies
// including the cobalt fallback (it never ran). Fix = bypass local yt-dlp
// execution entirely:
//   1. Aggressive URL regex — extract ONLY the first valid http(s) URL from the
//      garbage text first.
//   2. TikTok Fast-Track — for tiktok.com / vt.tiktok.com / vm.tiktok.com,
//      bypass yt-dlp AND cobalt; GET https://www.tikwm.com/api/?url=<url> and
//      use data.music (or data.play) as audio, data.title + data.cover for meta.
//   3. YouTube/Generic — for ALL non-TikTok URLs, no yt-dlp at all; POST to a
//      round-robin pool of public Cobalt instances, headers
//      { "Accept": "application/json" }, payload { url, isAudioOnly: true }.
//   4. Response normalization — both paths return the SAME JSON to the frontend
//      including { audioUrl, title, cover, artist } (server-side proxy: audio
//      is downloaded + ffprobe-verified + stored locally, player unchanged).
//
// EVERY new-behavior check FAILS against 18bfc42; the fix must make them PASS.
// Hermetic (no network), matching repo conventions.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const files = {
  extractLib: resolve(root, "src/lib/extract.ts"),
  extractRoute: resolve(root, "src/app/api/extract/route.ts"),
  cobalt: resolve(root, "src/lib/cobalt.ts"),
  ytdlp: resolve(root, "src/lib/ytdlp.ts"),
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

// G1 — AGGRESSIVE URL REGEX: extract the first valid http(s) URL from the
// share-sheet garbage text before anything else (must stay applied in route).
{
  const r = src("extractRoute") + src("extractLib");
  const extractor = /extractValidUrl|extractFirstUrl|parseFirstUrl|extractUrl/i.test(r);
  const applied = /(?:extractValidUrl|extractFirstUrl|parseFirstUrl)\(\s*(?:String\(\s*)?(?:body\??\.url|raw|text|input)/.test(src("extractRoute")) ||
    /(?:extractValidUrl|extractFirstUrl|parseFirstUrl)\(\s*(?:body\??\.url|\w+)\s*\)/.test(src("extractRoute"));
  if (extractor && applied) pass("G1: /api/extract extracts the first valid http(s) URL before anything else");
  else fail(`G1: URL-regex extraction missing/not applied (extractor=${extractor}, applied=${applied})`);
}

// G2 — TIKTOK FAST-TRACK via TikWM: a TikTok branch must exist that DIRECTLY
// GETs https://www.tikwm.com/api/?url=... and uses data.music (or data.play),
// data.title, data.cover. No yt-dlp, no cobalt for TikTok.
{
  const s = src("extractLib");
  const tikwmCall = /https?:\/\/www\.tikwm\.com\/api[^\s"']*\/\?url=|\/api\/\?url=\$\{/.test(s) ||
    /tikwm\.com\/api/.test(s);
  const tiktokDetect = /tiktok\.com/.test(s) &&
    /(?:vt\.|vm\.|www\.)?tiktok\.com/.test(s);
  const musicParse = /data\.music|\[["']music["']\]|\.music\b/.test(s);
  const playParse = /data\.play|\[["']play["']\]/.test(s);
  const coverParse = /data\.cover|\[["']cover["']\]|\.cover\b/.test(s);
  const titleParse = /data\.title|\[["']title["']\]/.test(s);
  if (tikwmCall && tiktokDetect && musicParse && coverParse && titleParse) {
    pass("G2: TikTok fast-track GETs tikwm.com/api?url= and parses data.music + data.title + data.cover");
  } else {
    fail(`G2: no TikWM fast-track (call=${tikwmCall}, detect=${tiktokDetect}, music=${musicParse}, play=${playParse}, cover=${coverParse}, title=${titleParse})`);
  }
}

// G3 — NO LOCAL yt-dlp for generic extraction: extract.ts must not execute
// local yt-dlp (getMediaInfo / extractAudioToFile) on the extract path.
{
  const s = src("extractLib");
  const usesYtDlpDownload = /getMediaInfo\(/.test(s) || /extractAudioToFile\(/.test(s);
  const usesYtDlpImport = /from\s+["']\.\/ytdlp["'][\s\S]{0,200}getMediaInfo/.test(s);
  if (!usesYtDlpDownload && !usesYtDlpImport) {
    pass("G3: extract path has NO local yt-dlp execution (getMediaInfo/extractAudioToFile removed)");
  } else {
    fail(`G3: local yt-dlp still used on extract path (download=${usesYtDlpDownload}, import=${usesYtDlpImport})`);
  }
}

// G3b — ffprobe integrity gate SURVIVES (server-side proxy) so audio still
// plays fully: probeAudioDuration must still be called before accepting a file.
{
  const s = src("extractLib");
  const probe = /probeAudioDuration\(/.test(s);
  if (probe) pass("G3b: ffprobe integrity gate retained (downloaded audio still verified)");
  else fail("G3b: probeAudioDuration lost — downloaded audio unverified");
}

// G4 — COBALT POOL: non-TikTok generic fallback POSTs { url, isAudioOnly: true }
// with Accept: application/json across a round-robin pool with >=2 public
// instances (incl. api.cobalt.tools).
{
  const c = src("cobalt");
  const instances = [...c.matchAll(/["'`]https:\/\/[a-z0-9.-]+(?:\/[a-z0-9.-]*)?["'`]/g)].map((m) => m[0]);
  const isAudioOnly = /isAudioOnly\s*[:=]/.test(c);
  const acceptJson = /Accept\s*:\s*["']application\/json["']/.test(c) ||
    /["']Accept["']\s*:\s*["']application\/json["']/.test(c);
  const hasTools = /api\.cobalt\.tools/.test(c);
  const loopOverAll = /for\s*\([^)]*(?:instance|base|host|entry|candidate)[^)]*\)/.test(c) ||
    /COBALT_INSTANCES\.(?:map|forEach|entries|values)/.test(c) || /of\s+CobaltInstances|of\s+COBALT_INSTANCES/.test(c);
  if (instances.length >= 2 && isAudioOnly && acceptJson && hasTools && loopOverAll) {
    pass(`G4: cobalt round-robin pool (${instances.length} instances) POSTs { url, isAudioOnly: true } + Accept: application/json`);
  } else {
    fail(`G4: cobalt pool/isAudioOnly/Accept missing (instances=${instances.length}, isAudioOnly=${isAudioOnly}, accept=${acceptJson}, hasTools=${hasTools}, loop=${loopOverAll})`);
  }
}

// G5 — RESPONSE NORMALIZATION: /api/extract returns the same JSON for BOTH
// paths, including { audioUrl, title, cover, artist } (server-side proxy keeps
// id/audioUrl=/api/audio/{id}/metaUrl for the player).
{
  const r = src("extractRoute");
  const audioUrl = /audioUrl\s*:/.test(r);
  const title = /title\s*:/.test(r);
  const cover = /cover\s*(?::|===)|\bcover\s*:/.test(r) || /cover\b/.test(r);
  const artist = /artist\s*:/.test(r);
  if (audioUrl && title && cover && artist) {
    pass("G5: normalized response carries { audioUrl, title, cover, artist } for both routes");
  } else {
    fail(`G5: normalized { audioUrl, title, cover, artist } missing/partial (audioUrl=${audioUrl}, title=${title}, cover=${cover}, artist=${artist})`);
  }
}

console.log(`\n[verify-external-routing] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);