#!/usr/bin/env node
/**
 * verify-youtube-ytdlp-first.mjs — acceptance gate for the "YouTube extraction
 * reliability" fix (freebuff-task-20260821-004038).
 *
 * WHY: as of 2026-08-20 the hardcoded cobalt pool is dead (v7 endpoints
 * removed; v10/v11 instances are turnstile/API-key gated; `isAudioOnly` was
 * dropped from the v11 schema) AND the cobalt-first routing sends every
 * YouTube URL through that dead pool before the local yt-dlp fallback, whose
 * audio path has NO player-client failover — so videos that need the `tv`
 * client (e.g. HfpR4tAmI7E, jNQXAC9IVRw) fail on Render's datacenter IP even
 * though yt-dlp works from residential IPs. This gate pins the fix.
 *
 * All checks are static (file-content based) so the gate runs offline, fast
 * and deterministic. Names are markers; keep them stable in the source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const read = (p) => readFileSync(path.join(root, p), "utf8");

let failures = 0;
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const cobalt = read("src/lib/cobalt.ts");
const extract = read("src/lib/extract.ts");
const ytdlp = read("src/lib/ytdlp.ts");

// G1 — pool carries the live 2026 instances (from the official directory,
// https://cobalt.directory/api/working?type=api, youtube set, 2026-08-20).
const LIVE_INSTANCES = [
  "fox.kittycat.boo",
  "subito-c.meowing.de",
  "cobalt-api.lamps-dev.dev",
  "nuko-c.meowing.de",
  "kitty.tame.gg",
  "api.cobalt.rpkiinval.id",
  "bergung-api.hoffnungfuerdiezukunft.net",
];
check(
  "G1 cobalt pool refreshed to live instances",
  LIVE_INSTANCES.every((i) => cobalt.includes(i)),
  LIVE_INSTANCES.filter((i) => !cobalt.includes(i)).join(", ") || "all present",
);

// G2 — v11 schema: request body must NOT carry `isAudioOnly` (dropped in the
// v11 api; unknown keys are rejected with HTTP 400 by live instances).
check(
  "G2 no isAudioOnly in cobalt request body",
  !/isAudioOnly/.test(cobalt),
  "isAudioOnly still present" ,
);

// G3a — the audio download path (-x) in extract.ts must apply the same
// player-client variants as getMediaInfo (default,-android_sdkless THEN tv
// THEN android_vr), so datacenter-IP videos are retried with tv/android_vr
// instead of dying on the first client.
check(
  "G3a tryYtdlpDirect audio path uses client failover variants",
  /PLAYER_CLIENT_VARIANTS/.test(extract) &&
    /--extractor-args/.test(extract) &&
    /android_sdkless/.test(extract) &&
    /player_client=tv/.test(extract) &&
    /player_client=android_vr/.test(extract),
  "client failover markers missing from extract.ts",
);

// G3b — ytdlp.ts PLAYER_CLIENT_VARIANTS includes android_vr as a third try.
check(
  "G3b ytdlp.ts variants include android_vr",
  /PLAYER_CLIENT_VARIANTS/.test(ytdlp) && /player_client=android_vr/.test(ytdlp),
  "android_vr variant missing",
);

// G4 — routing: doExtract tries yt-dlp FIRST for YouTube-family URLs
// (youtube.com / music.youtube.com / youtu.be); cobalt remains the fallback.
check(
  "G4 youtube-family URLs route to yt-dlp before cobalt",
  /isYouTubeFamilyUrl|youtubeFamily|youtube-family/i.test(extract) &&
    extract.includes("tryYtdlpDirect") &&
    (() => {
      const yt = extract.indexOf("tryYtdlpDirect(url");
      const co = extract.indexOf("tryCobaltFallback(url");
      return yt !== -1 && co !== -1 && yt < co;
    })(),
  "yt-dlp-first branch missing or ordered after cobalt",
);

// G5 — when BOTH routes fail, the surfaced error must carry BOTH chains
// (cobalt last error AND the yt-dlp error) so the UI can show what happened.
check(
  "G5 dual error chain surfaced on total failure",
  /ytdlpErr|yt-dlp/i.test(extract) &&
    extract.includes("All Cobalt instances failed") &&
    (() => {
      const err = extract.indexOf("throw");
      const msg = extract.slice(err, err + 1200);
      return /cobalt/i.test(msg) && /ytdlp|yt-dlp/i.test(msg);
    })(),
  "dual-chain markers missing",
);

// G6 — body keys stay within the v11 schema (no legacy keys in the POST /).
check(
  "G6 v11 request body only (url/downloadMode/audioFormat/filenameStyle)",
  !/youtubeVideoCodec|disableMetadata|videoQuality/i.test(cobalt),
  "legacy schema keys present",
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} gate check(s) FAILED — see above`);
  process.exit(1);
}