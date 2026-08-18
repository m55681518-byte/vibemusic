// Acceptance gate for Turn G: multi-source lyrics fallback pipeline + karaoke UI.
// Two user requests, one task:
//  A) Backend multi-source fallback: LRCLIB (synced) -> Genius/public text provider
//     (plain) -> yt-dlp auto-captions (SRT) as final fallback.
//  B) Frontend karaoke: LRC parse util, timeupdate sync engine with activeLineIndex,
//     Spotify-style active/inactive styling, scrollIntoView center auto-scroll,
//     manual-scroll pause with auto-resume after 3s.
//
// Current code FAILS all *-NEW checks (only LRCLIB backend; no captions; no karaoke).
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcLib = resolve(root, "src/lib");
const routeFile = resolve(root, "src/app/api/lyrics/route.ts");
const playerFile = resolve(root, "src/components/PlayerView.tsx");
const lyricsViewFile = resolve(root, "src/components/LyricsView.tsx");
const cssFile = resolve(root, "src/app/globals.css");

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

const libSrc = readdirSync(srcLib)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => read(resolve(srcLib, f)))
  .join("\n");
const routeSrc = read(routeFile);
const playerSrc = read(playerFile);
const lyricsViewSrc = read(lyricsViewFile);
const cssSrc = read(cssFile);

// ---- BACKEND: multi-source fallback ----
// B1. LRCLIB still queried for synced lyrics first (must remain).
const lrclib = /lrclib\.net|LRCLIB_BASE_URL|\/get\?artist_name|\/search\?q=/.test(libSrc);
if (lrclib) pass("B1: LRCLIB queried for synced lyrics");
else fail("B1: LRCLIB lookup missing");

// B2. NEW — a second key-free text-lyrics provider (Genius public API or similar
//     public text provider) is wired into the fallback chain, mapped to plain text.
const fallbackProvider = /genius\.com|api\.genius|lyrics\.ovh|textyl|another-lyrics|chartlyrics/i.test(libSrc);
const plainMapping = /plain:\s*[a-zA-Z_][\w.]*|\{\s*plain\s*:|\.plain\s*=|plain\s*\?\?/.test(libSrc);
if (fallbackProvider && plainMapping) pass("B2: key-free text-lyrics fallback provider wired (plain mapped)");
else fail(`B2: no second text-lyrics provider (fallbackProvider=${fallbackProvider}, plainMapping=${plainMapping})`);

// B3. NEW — yt-dlp extraction pulls platform auto-captions (--write-auto-subs,
//     --convert-subs srt) so a caption file lands next to the MP3.
const writeAutoSubs = /--write-auto-subs|--write-subs/.test(libSrc);
const convertSrt = /--convert-subs[\s\S]{0,12}["']srt["']|--convert-subtitles[\s\S]{0,12}["']srt["']/.test(libSrc);
if (writeAutoSubs && convertSrt) pass("B3: yt-dlp args pull auto-captions as SRT (--write-auto-subs --convert-subs srt)");
else fail(`B3: yt-dlp auto-caption args missing (writeAutoSubs=${writeAutoSubs}, convertSrt=${convertSrt})`);

// B4. NEW — SRT caption parser exists (reads SRT timestamp blocks -> lines/text).
const srtParser = /function\s+(parseSrt|srtToLyrics|srtToPlain|captionsTo|srtToLrc)\b|const\s+(parseSrt|srtToLyrics|srtToPlain|captionsTo)\b|parseSrt\s*[:=]/.test(libSrc);
const srtTimecode = /-->\s*\d{1,3}:\d{2}:\d{2}|\d{1,2}:\d{2}:\d{2},\d{3}\s*--\s*>/.test(libSrc);
if (srtParser || (srtTimecode && /srt|vtt|caption/i.test(libSrc))) pass("B4: SRT/caption parser implemented in lib");
else fail(`B4: no SRT/caption parser (srtParser=${srtParser}, srtTimecode=${srtTimecode})`);

// B5. NEW — lyrics route accepts an optional track id and the fallback chain can
//     consume the stored caption file as the final text fallback.
const routeAcceptsId = /searchParams\.get\(["']id["']\)|searchParams\.get\(["']captions["']\)|searchParams\.get\(["']url["']\)/.test(routeSrc);
const captionFallback = /srt|captions?|subtitles?/.test(routeSrc + libSrc);
if (routeAcceptsId && captionFallback) pass("B5: lyrics route can locate track captions as final fallback");
else fail(`B5: route/caption fallback missing (routeAcceptsId=${routeAcceptsId}, captionFallback=${captionFallback})`);

// ---- FRONTEND: karaoke ----
// F1. LRC parse util returns lines with a time field (exists: parseLrc -> {time,text}).
const lrcParse = /function\s+parseLrc\b|const\s+parseLrc\b|parseLrc\s*[:=]/.test(playerSrc + lyricsViewSrc + libSrc);
const lrcTimeField = /timeInSeconds|\.time\b|\btime:\s*number/.test(libSrc);
if (lrcParse && lrcTimeField) pass("F1: LRC parser produces timed lines");
else fail(`F1: LRC parser missing (lrcParse=${lrcParse}, lrcTimeField=${lrcTimeField})`);

// F2. Sync engine: timeupdate listener + activeLineIndex bound to currentTime.
const timeUpdate = /timeupdate/.test(playerSrc);
const activeIndex = /activeIndex|activeLineIndex/.test(playerSrc + lyricsViewSrc);
if (timeUpdate && activeIndex) pass("F2: timeupdate sync engine computes active line index");
else fail(`F2: sync engine missing (timeUpdate=${timeUpdate}, activeIndex=${activeIndex})`);

// F3. NEW — active line auto-scrolls to vertical center via scrollIntoView smooth center.
const scrollIntoView = /scrollIntoView\(\{[\s\S]{0,120}behavior:\s*["']smooth["'][\s\S]{0,120}block:\s*["']center["']/.test(lyricsViewSrc);
if (scrollIntoView) pass("F3: active line scrollIntoView({ behavior: smooth, block: center })");
else fail("F3: no scrollIntoView smooth center scroll");

// F4. NEW — manual scroll pauses auto-scroll; auto-resume after ~3s inactivity.
const manualPause = /onScroll|onWheel|onTouchStart/.test(lyricsViewSrc);
const resumeTimer = /setTimeout\s*\([\s\S]{0,80}\b3\d{3}\b|resume|paused|userScrolled|isScrolling|pauseAutoScroll/i.test(lyricsViewSrc);
if (manualPause && resumeTimer) pass("F4: manual-scroll pause + ~3s auto-resume");
else fail(`F4: manual-scroll/resume logic missing (manualPause=${manualPause}, resumeTimer=${resumeTimer})`);

// F5. NEW — karaoke styling: active line bright/large with glow; inactive dimmed.
const activeGlow = /\.lyric-line\.is-active[\s\S]{0,300}text-shadow/.test(cssSrc);
const inactiveDim = /\.lyric-line[\s\S]{0,200}opacity\s*:\s*(0\.[0-9]+|<1\b)|:not\(\.is-active\)[\s\S]{0,200}opacity/.test(cssSrc);
const activeBigger = /\.lyric-line\.is-active[\s\S]{0,300}(font-size|scale|transform)/.test(cssSrc);
if (activeGlow && inactiveDim && activeBigger) pass("F5: karaoke CSS (active glow+bigger, inactive dimmed)");
else fail(`F5: karaoke CSS incomplete (activeGlow=${activeGlow}, inactiveDim=${inactiveDim}, activeBigger=${activeBigger})`);

console.log(`\n[verify-lyrics-engine] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
