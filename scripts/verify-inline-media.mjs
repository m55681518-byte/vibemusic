// Acceptance gate for Turn E: Content-Disposition must not break inline playback.
// Root cause (verified live): src/app/api/audio/[id]/route.ts sets
//   Content-Disposition: attachment  on EVERY response, INCLUDING the 206 media
//   stream the <audio> element requests (Range bytes=0-). Chromium media stack
//   treats attachment-disposition responses as downloads and aborts the stream
//   (net::ERR_ABORTED) -> the track never plays in a real browser. The download
//   anchor must instead request the attachment explicitly.
//
// Hard checks (all must PASS after the fix; gate FAILs on the current code):
//  1. audio route only emits Content-Disposition when the client asks for a
//     download explicitly (query ?download=1 or similar); media/Range requests
//     get NO attachment disposition (inline playback).
//  2. audio route still serves Range/206 partial content (no regression).
//  3. PlayerView download anchor points at the explicit download URL
//     (/api/audio/{id}?download=1) and keeps the download attribute.
//  4. PlayerView <audio> src points at the plain media URL (no download param).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const audioRoute = resolve(root, "src/app/api/audio/[id]/route.ts");
const player = resolve(root, "src/components/PlayerView.tsx");

let passed = 0;
let failed = 0;
const pass = (msg) => { console.log("PASS", msg); passed++; };
const fail = (msg) => { console.log("FAIL", msg); failed++; };

// Check 1: attachment disposition gated on explicit download request.
if (!existsSync(audioRoute)) {
  fail("audio route missing (check 1)");
} else {
  const src = readFileSync(audioRoute, "utf8");
  const downloadTrigger = /download\s*[:=]|\?download=1|searchParams\.get\(["']download["']\)/.test(src);
  const attachmentInsideDownloadBranch = /download[\s\S]{0,120}Content-Disposition/.test(src)
    || /Content-Disposition[\s\S]{0,120}download/.test(src);
  if (downloadTrigger && attachmentInsideDownloadBranch) {
    pass("audio route gates Content-Disposition behind explicit download request");
  } else {
    fail(`audio route does not gate attachment behind ?download=1 (trigger=${downloadTrigger}, inBranch=${attachmentInsideDownloadBranch})`);
  }
}

// Check 2: Range/206 still supported.
if (!existsSync(audioRoute)) {
  fail("audio route missing (check 2)");
} else {
  const src = readFileSync(audioRoute, "utf8");
  if (/206/.test(src) && /Content-Range/.test(src) && /req\.headers\.get\(["']range["']\)/.test(src)) {
    pass("audio route still serves Range/206 partial content");
  } else {
    fail("audio route lost Range/206 support");
  }
}

// Check 3: PlayerView download anchor uses explicit download URL + attribute.
if (!existsSync(player)) {
  fail("PlayerView missing (check 3)");
} else {
  const src = readFileSync(player, "utf8");
  const downloadUrl = /api\/audio\/\$\{meta\.id\}\?download=1/.test(src) || /api\/audio\/\$\{meta\.id\}[^\n]*download=1/.test(src);
  const downloadAttr = /download=\{?fileName\}?/.test(src) || /download=\{?\s*fileName\s*\}?/.test(src);
  if (downloadUrl && downloadAttr) pass("PlayerView download anchor targets ?download=1 with download attr");
  else fail(`PlayerView download anchor not explicit (downloadUrl=${downloadUrl}, attr=${downloadAttr})`);
}

// Check 4: PlayerView <audio> src is the plain media URL (no download param).
if (!existsSync(player)) {
  fail("PlayerView missing (check 4)");
} else {
  const src = readFileSync(player, "utf8");
  const apiFallback = /\/api\/audio\/\$\{meta\.id\}/.test(src);
  const noDownloadInAudio = !/<audio[\s\S]{0,200}\?download=1/.test(src);
  if (apiFallback && noDownloadInAudio) pass("PlayerView <audio> src is media-safe (API fallback, no download param)");
  else fail("PlayerView <audio> src must keep the /api/audio/{id} fallback and never use ?download=1");
}

console.log(`\n[verify-inline-media] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
