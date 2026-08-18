// Acceptance gate: activate the DEAD third ladder rung — on-demand caption
// fallback — so every YouTube/YouTube-Music track can get karaoke lyrics even
// when LRCLIB and Genius both miss.
//
// WHY THE CURRENT PIPELINE FAILS IN PRODUCTION (session-agent verified):
//   Journal 020 added rung 3 = read a stored auto-caption <id>.<lang>.srt that
//   yt-dlp wrote during extraction (--write-auto-subs --convert-subs srt).
//   BUT on Render the audio is almost always extracted by COBALT (yt-dlp 403
//   from datacenter IP), and cobalt writes no .srt. So captionsForId(id)
//   finds nothing, rung 3 never fires, and "some songs" return empty lyrics.
//
// THE FIX: fetch YouTube timedtext captions ON DEMAND for the video id when
//   the stored-file path misses, parse them into timed lines, and hand them
//   back as LRC-formatted synced lyrics so the karaoke UI renders them. Keep
//   rung order LRCLIB -> Genius -> stored-srt -> on-demand-captions.
//
// Hard checks (all must PASS after the fix; gate FAILs on current main):
//  1. lyrics.ts exposes a pure captions parser (timedtext JSON3 / SRT input ->
//     SrtLine[]) and an LRC builder (SrtLine[] -> "[mm:ss.mmm] text" string).
//  2. lookupLyrics accepts the source video URL (4th arg) and falls back to
//     on-demand caption fetch AFTER the stored-file caption path misses.
//  3. on-demand captions are returned as SYNCED LRC (parseable by the karaoke
//     UI), not only plain text — the UI must show them in sync.
//  4. /api/lyrics route resolves the stored meta (loadMeta(id)) and passes its
//     webpageUrl into lookupLyrics.
//  5. LRCLIB is still tried before captions (rung order preserved: LRCLIB
//     first, captions last).
//  6. extract.ts still carries yt-dlp's --write-auto-subs / --convert-subs srt
//     (stored-srt path regression guard).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const lyrics = resolve(root, "src/lib/lyrics.ts");
const route = resolve(root, "src/app/api/lyrics/route.ts");
const extract = resolve(root, "src/lib/extract.ts");

let passed = 0;
let failed = 0;
const pass = (msg) => { console.log("PASS", msg); passed++; };
const fail = (msg) => { console.log("FAIL", msg); failed++; };

const lyricsSrc = existsSync(lyrics) ? readFileSync(lyrics, "utf8") : "";
const routeSrc = existsSync(route) ? readFileSync(route, "utf8") : "";
const extractSrc = existsSync(extract) ? readFileSync(extract, "utf8") : "";

// Check 1: pure captions parser + LRC builder exist in lyrics.ts.
{
  const hasParser = /(parseCaptions|parseTimedText|parseJson3|parseSrt)/.test(lyricsSrc);
  const hasLrcBuilder = /(buildLrc|toLrc|lrcFrom|toSyncedLrc)/.test(lyricsSrc);
  const parserFallsToSrt = /parseSrt/.test(lyricsSrc); // keep pulling stored-srt through the same shape
  if (hasParser && hasLrcBuilder && parserFallsToSrt) {
    pass("lyrics.ts has a captions parser + LRC builder (SrtLine[] -> LRC)");
  } else {
    fail(`missing captions parser or LRC builder (hasParser=${hasParser}, lrcBuilder=${hasLrcBuilder}, srt=${parserFallsToSrt})`);
  }
}

// Check 2: lookupLyrics takes a 4th source-URL arg and falls back to on-demand captions.
{
  const hasUrlParam = /lookupLyrics\([^)]*url[^)]*\)|lookupLyrics\([^)]*webpageUrl[^)]*\)|sourceUrl|videoId|videoUrl/.test(lyricsSrc);
  const fallbackAfterSrt = /makeCaptionSrt|\bcaptions|onDemand|fetchCaptions|getCaptions|lookupCaptions/.test(lyricsSrc);
  const orderAfterLrclib = lyricsSrc.indexOf("lookupLrclib") < lyricsSrc.indexOf("onDemand") ||
                           lyricsSrc.indexOf("lookupLrclib") < lyricsSrc.indexOf("fetchCaptions") ||
                           lyricsSrc.indexOf("lookupLrclib") < lyricsSrc.indexOf("getCaptions");
  if (hasUrlParam && fallbackAfterSrt && orderAfterLrclib) {
    pass("lookupLyrics accepts source URL and falls back to on-demand captions after LRCLIB");
  } else {
    fail(`no on-demand caption path wired into lookupLyrics (urlParam=${hasUrlParam}, fallback=${fallbackAfterSrt}, afterLrclib=${orderAfterLrclib})`);
  }
}

// Check 3: on-demand captions return SYNCED LRC so the karaoke UI is used.
{
  // The caption fallback must set `synced` (newline-joined "[mm:ss] line" LRC),
  // not just `plain` — otherwise the UI falls back to the plain <pre>.
  const setsSyncedFromCaptions = /synced\s*:\s*(buildLrc|toLrc|lrcFrom|toSyncedLrc)[\s\S]{0,80}plain/.test(lyricsSrc) ||
                                  /const synced[\s\S]{0,120}captionsToPlain|buildLrc[\s\S]{0,40}synced/.test(lyricsSrc);
  if (setsSyncedFromCaptions) {
    pass("caption fallback returns synced LRC (karaoke renders it, not plain <pre>)");
  } else {
    fail(`caption fallback does not produce synced LRC (only plain?)`);
  }
}

// Check 4: route resolves meta and passes webpageUrl into lookupLyrics.
{
  const loadsMeta = /loadMeta\s*\(\s*id\s*\)/.test(routeSrc);
  const passesUrl = /lookupLyrics\([\s\S]{0,200}webpageUrl\)/.test(routeSrc) || /lookupLyrics\([\s\S]{0,200}\.url\b/.test(routeSrc);
  if (loadsMeta && passesUrl) {
    pass("/api/lyrics resolves meta and passes webpageUrl to lookupLyrics");
  } else {
    fail(`route does not feed video URL into lookupLyrics (loadsMeta=${loadsMeta}, passesUrl=${passesUrl})`);
  }
}

// Check 5: LRCLIB kept as primary rung.
{
  const lrclibFirst = lyricsSrc.indexOf("lookupLrclib") !== -1 &&
    (lyricsSrc.indexOf("lookupLrclib") < lyricsSrc.indexOf("lookupGenius") ||
     lyricsSrc.indexOf("lookupLrclib") < lyricsSrc.indexOf("searchGenius") ||
     lyricsSrc.indexOf("lookupLrclib") < lyricsSrc.indexOf("genius"));
  if (lrclibFirst) {
    pass("LRCLIB remains the primary source (rung order preserved)");
  } else {
    fail(`LRCLIB no longer first rung (lrclibFirst=${lrclibFirst})`);
  }
}

// Check 6: stored-srt args regression guard — live in ytdlp.ts downloadAutoCaptions
// (extract.ts is 100% external since journal 030; captions come from ytdlp.ts).
{
  const ytdlp = resolve(root, "src/lib/ytdlp.ts");
  const ytdlpSrc = existsSync(ytdlp) ? readFileSync(ytdlp, "utf8") : "";
  const autoSubs = /--write-auto-subs/.test(ytdlpSrc);
  const convertSrt = /--convert-subs/.test(ytdlpSrc) && /srt/.test(ytdlpSrc);
  if (autoSubs && convertSrt) {
    pass("ytdlp.ts downloadAutoCaptions requests auto-captions + SRT conversion (stored path intact)");
  } else {
    fail(`ytdlp.ts lost --write-auto-subs/--convert-subs srt (autoSubs=${autoSubs}, convert=${convertSrt})`);
  }
}

console.log(`\n[verify-caption-fallback] ${passed}/${passed + failed} checks passed`);
process.exit(failed > 0 ? 1 : 0);