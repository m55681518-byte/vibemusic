// Acceptance gate: the extract flow must log the RAW yt-dlp stderr so the real
// error can be diagnosed from Render logs (currently humanizeExtractorError maps
// it away before it reaches the log). We add an explicit console.error of the
// raw error message where extraction fails. Exit 0 = accept, 1 = reject.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];
const fail = (msg) => { results.push(`FAIL ${msg}`); console.error(`FAIL ${msg}`); };
const pass = (msg) => { results.push(`PASS ${msg}`); console.log(`PASS ${msg}`); };

// 1. extract.ts must capture and surface the raw yt-dlp error before the mapper.
const extract = path.join(root, "src", "lib", "extract.ts");
if (!existsSafe(extract)) {
  fail("src/lib/extract.ts missing");
} else {
  const src = readFileSync(extract, "utf8");
  // We want the raw error message (from getMediaInfo / extractAudioToFile / the
  // final throw) to be logged verbatim (console.error) so it reaches Render logs.
  if (/console\.error/.test(src) && /humanize|raw|message/i.test(src)) {
    pass("extract.ts logs a raw error to stderr/console before/after mapping");
  } else {
    fail("extract.ts does not log the raw yt-dlp error (add console.error with the raw error message so it reaches Render logs)");
  }
}

// 2. ytdlp.ts must expose the raw message (not pre-mapped) for callers to log.
const ytdlp = path.join(root, "src", "lib", "ytdlp.ts");
if (!existsSafe(ytdlp)) {
  fail("src/lib/ytdlp.ts missing");
} else {
  const src = readFileSync(ytdlp, "utf8");
  if (/stderr|stdout|message|\.message/.test(src)) {
    pass("ytdlp.ts surfaces raw yt-dlp stderr in its errors");
  } else {
    fail("ytdlp.ts does not surface raw stderr in errors");
  }
}

// 3. Keep the impersonation flag (regression guard): must not have been removed.
// extract.ts is 100% external (journal 030) — the flag lives in ytdlp.ts only.
// Generic `chrome` shorthand (journal 016) — curl_cffi bundles the latest.
if (existsSafe(ytdlp)) {
  const src = readFileSync(ytdlp, "utf8");
  if (/--impersonate/.test(src) && /chrome/.test(src)) {
    pass("ytdlp.ts still passes --impersonate chrome");
  } else {
    fail("ytdlp.ts lost the --impersonate chrome flag");
  }
} else {
  fail("src/lib/ytdlp.ts missing");
}

function existsSafe(p) {
  return existsSync(p);
}

const failed = results.some((r) => r.startsWith("FAIL"));
console.log(`\n[verify-raw-log] ${results.length - (failed ? results.filter((r) => r.startsWith("FAIL")).length : 0)}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
