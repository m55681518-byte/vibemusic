// Acceptance gate: "fix plays-partly-and-stops + no-lyrics ONCE AND FOR ALL"
// (freebuff-task-20260816-183748).
//
// Live reproduction (https://music.youtube.com/watch?v=ksBrPP45Rms, "BAILA
// LENTO (Slowed)" by sma$her, MC DA$ILVA — 95s):
//   1. /api/extract 422 "private or requires a login" (yt-dlp bot block on
//      Render datacenter IP); cobalt tunnels yield 0 bytes / 404 expiry, so
//      the user gets a dead track that "plays partly then stops" (truncated/
//      empty file served with partial audio).
//   2. Cobalt filename "BAILA LENTO (Slowed) - Release.mp3" parses to
//      title="BAILA LENTO (Slowed)", artist="Release" (junk channel token).
//      lookupLyrics then queries LRCLIB with artist="Release" → 0 hits, so
//      NO lyrics ever show. A TITLE-ONLY search returns 12 hits incl. the
//      exact "BAILA LENTO by sma$her,MC DA$ILVA" (dur 95).
//
// EVERY check FAILS against c5dab40; the fix must make them all PASS.
// Hermetic (no network), matching repo conventions.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const files = {
  extract: resolve(root, "src/lib/extract.ts"),
  ytdlp: resolve(root, "src/lib/ytdlp.ts"),
  cobalt: resolve(root, "src/lib/cobalt.ts"),
  lyrics: resolve(root, "src/lib/lyrics.ts"),
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

// G1 — PLAY-FULLY: extract.ts must VERIFY the stored mp3 with ffprobe after
// download (both yt-dlp and cobalt paths) and record the real duration so a
// truncated/partial file is never served as a complete track.
{
  const s = src("extract");
  const usesProbe = /probeAudioDuration/.test(s);
  const importsProbe = /import[\s\S]{0,200}probeAudioDuration/.test(s) ||
    /probeAudioDuration[\s\S]{0,20}from\s+["']\.\/ytdlp/.test(s);
  const probesFile = /probeAudioDuration\(\s*mp3Path\s*\)/.test(s) ||
    /probeAudioDuration\(mp3PathFor\(/ .test(s);
  const storesDuration = /duration:\s*(?:probed|probedDuration|actualDuration)/.test(s) ||
    /duration\s*=\s*(?:probed|probedDuration)/.test(s);
  if (usesProbe && importsProbe && probesFile && storesDuration) pass("G1: extract.ts probes written mp3 with ffprobe and stores real duration");
  else fail(`G1: no ffprobe verification of the stored mp3 (probe=${usesProbe}, import=${importsProbe}, probesFile=${probesFile}, duration=${storesDuration})`);
}

// G1b — download integrity: refuse to persist a dubious body (empty / tiny /
// unverifiable) instead of writing a broken track that "plays partly".
{
  const s = src("extract");
  const sizeGuard = /buffer\.length\s*[=!<>]/.test(s) || /!buffer\.length/.test(s);
  const probeGuard = /probeAudioDuration[\s\S]{0,80}null/.test(s) ||
    /probedDuration[\s\S]{0,40}null[\s\S]{0,40}(?:throw|continue|unlink|skip|continue)/.test(s);
  if (sizeGuard && probeGuard) pass("G1b: empty/tiny bodies are refused (size+probe guards)");
  else fail(`G1b: dubious download bodies not refused (sizeGuard=${sizeGuard}, probeGuard=${probeGuard})`);
}

// G2 — EXTRACTABILITY: extract.ts must try an ALTERNATIVE player client
// (tv/web_embedded/…) on the failover attempt so the server is not stuck on a
// single blocked client, AND the cobalt instance list must have >=3 entries.
{
  const e = src("extract");
  const altClient = /player_client\s*=\s*(?:tv|web_embedded|tv_embedded|web_safari)/.test(e) ||
    /(?:tv|web_embedded|tv_embedded)["'],/.test(e);
  if (altClient) pass("G2: extract failover uses an alternative player client");
  else fail("G2: no alternative player client in the failover attempt");

  const c = src("cobalt");
  const instances = [...c.matchAll(/["'`]https:\/\/[a-z0-9.-]+["'`]/g)].map((m) => m[0]);
  if (instances.length >= 3) pass(`G2b: cobalt instance list has ${instances.length} entries (redundancy)`);
  else fail(`G2b: cobalt has only ${instances.length} instance(s) — tunnel 0-byte kills the fallback`);
}

// G3 — LYRICS: lookupLrclib must fall back to a TITLE-ONLY search when the
// "artist + title" query finds nothing (rescues junk-artist metadata).
{
  const s = src("lyrics");
  const hasSearch = /\/search\?q=/.test(s);
  const titleOnly = /encodeURIComponent\((?:title|t)\)/.test(s) &&
    /search\?q=\$\{encodeURIComponent\((?:title|t)\)\}/.test(s);
  const fallbackBranch = /!hit[\s\S]{0,200}\/search/.test(s) ||
    /if\s*\(\s*![\w.]+\s*\)\s*\{[\s\S]{0,300}search/.test(s) ||
    /titleOnly/.test(s);
  if (hasSearch && titleOnly && fallbackBranch) pass("G3: lookupLrclib has a title-only /search fallback query");
  else fail(`G3: no title-only LRCLIB fallback (search=${hasSearch}, titleOnly=${titleOnly}, branch=${fallbackBranch})`);
}

// G3b — the title-only fallback must still filter instrumentals out.
{
  const s = src("lyrics");
  const noInst = /!r\.instrumental/.test(s) || /r\.instrumental\s*===\s*false/.test(s) ||
    /\.instrumental/.test(s);
  if (noInst) pass("G3b: title-only results still exclude instrumentals");
  else fail("G3b: instrumental filtering lost in title-only fallback");
}

// G4 — the lyrics route must keep passing the REAL probed duration so synced
// LRC rescaling works for slowed variants.
{
  const s = src("extract") + src("lyrics") + src("ytdlp");
  const probeExported = /export (?:async )?function probeAudioDuration/.test(src("ytdlp"));
  const routeUsesProbe = /probeAudioDuration/.test(src("ytdlp") + src("extract"));
  if (probeExported && routeUsesProbe) pass("G4: probeAudioDuration exported + wired (duration feeding rescale)");
  else fail(`G4: probeAudioDuration export/wiring missing (exported=${probeExported}, wired=${routeUsesProbe})`);
}

// G5 — PlayerView must surface ALL lyrics states (synced/plain/instrumental)
// and keep the /api/audio streaming source as fallback (no backslide to
// blob-only playback; the <audio> element never points at ?download=1).
{
  const pth = resolve(root, "src/components/PlayerView.tsx");
  if (!existsSync(pth)) {
    fail("G5: PlayerView.tsx missing");
  } else {
    const p = readFileSync(pth, "utf8");
    const apiFallback = /\/api\/audio\/\$\{meta\.id\}/.test(p);
    const noDownloadInAudio = !/<audio[\s\S]{0,200}\?download=1/.test(p);
    const hasSynced = /lyrics\.synced/.test(p);
    const hasPlain = /lyrics\.plain/.test(p);
    const hasInst = /isInstrumental/.test(p);
    const lyricState = hasSynced && hasPlain && hasInst;
    if (apiFallback && noDownloadInAudio && lyricState) pass("G5: PlayerView handles synced/plain/instrumental + API audio fallback");
    else fail(`G5: PlayerView regression (apiFallback=${apiFallback}, noDownload=${noDownloadInAudio}, synced=${hasSynced}, plain=${hasPlain}, instrumental=${hasInst})`);
  }
}

console.log(`\n[verify-plays-and-lyrics] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);