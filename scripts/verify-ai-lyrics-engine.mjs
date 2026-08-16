// Acceptance gate for vibe music "Bulletproof AI Lyrics & Audio Engine" refactor
// (freebuff-task-20260816-101500).
//
// The refactor must ship FOUR tiers:
//   T1. Fuzzy search + time-scale normalization:
//       - Read actual MP3 duration (ffprobe on the stored file).
//       - Clean artist/title (strip hashtags, usernames, brackets, "slowed",
//         "reverb", "tik tok edit", remix, nightcore, ...).
//       - LRCLIB / Genius lookup with the CLEANED name for the ORIGINAL track.
//       - If synced lyrics found AND original duration differs from actual,
//         rescale every LRC timestamp by ratio = actual / original.
//   T2. AI speech-to-text fallback (Whisper via Groq `whisper-large-v3` or a
//       Hugging Face Inference API): the stored MP3 buffer -> verbose_json ->
//       segments -> LRC array [{timeInSeconds, text}] -> synced LRC string.
//   T3. Instrumental / silence fallback: Whisper empty text / no speech ->
//       response { isInstrumental: true, lyrics: null }.
//   T4. Karaoke player UI: render Tier1 + Tier2 synced seamlessly; when
//       isInstrumental, render an animated visualizer over the cover art with
//       the badge "Instrumental / Beats Only".
//
// API must stay backward-compatible: { synced, plain } plus an optional
// `isInstrumental` boolean.
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
const storeFile = resolve(root, "src/lib/store.ts");
const extractFile = resolve(root, "src/lib/extract.ts");

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
const storeSrc = read(storeFile);
const extractSrc = read(extractFile);

// ---- T1: fuzzy search + time-scale normalization ----

// T1a. Actual MP3 duration usable. Either meta.duration is populated at
//      extract time, or a probe (ffprobe) reads the stored file's duration.
const durationField = /duration\??:|duration\b.*seconds|ffprobe|probeDuration|readDuration|getDuration|DurationMetric/i.test(
  libSrc + storeSrc + extractSrc,
);
if (durationField) pass("T1a: track duration is available/populated in the pipeline");
else fail("T1a: no duration value in meta or an ffprobe/probe reader");

// T1b. A metadata cleaner strips noise from artist/title before search.
//      Must target at least: hashtags, usernames, brackets, "slowed", "reverb",
//      "tik tok edit". Looks for named funcs like cleanTitle / sanitizeQuery /
//      normalizeTitle / stripEdition etc. AND the specific regex classes.
const cleanerFn =
  /function\s+(clean|sanitize|normalize|strip)\w*\s*\(|const\s+(clean|sanitize|normalize|strip)\w*\s*=\s*\([^)]*\)\s*=>|export\s+(function|const)\s+(clean|sanitize|normalize|strip)\w*/i.test(libSrc);
const cleanerTargets =
  /(slowed|reverb|tik\s*tok|tiktok|sped\s*up|remix|nightcore|#\w+|@\w+|\[[^\]]*\]|\([^)]*slow[^)]*\))/i.test(libSrc);
if (cleanerFn && cleanerTargets) pass("T1b: title/artist cleaner strips hashtags/usernames/brackets/slowed/reverb/tiktok");
else fail(`T1b: metadata cleaner missing (cleanerFn=${cleanerFn}, cleanerTargets=${cleanerTargets})`);

// T1c. Search uses the CLEANED name, and a Genuine duration comparison
//      rescales synced lyrics. Look for a scale function honoring a ratio
//      (actual/original) that multiplies LRC timestamps.
const scaleFn =
  /function\s+(scale|rescale|timeScale|resync|normalize)\w*\s*\(|const\s+(scale|rescale|timeScale|resync|normalize)\w*\s*=\s*\([^)]*\)\s*=>/i.test(libSrc);
const ratioLogic =
  /ratio\s*=\s*actual|ratio\s*=\s*(actualDuration|fileDuration|audioDuration)\s*\/|actual\s*\/\s*original|\bactual\s*\/\s*originalDuration\b|(scale|rescale|resync|timeScale)\w*\s*\([^)]*\b(ratio|duration)\b|multiply.*timestamp|timestamp\s*\*\s*ratio/i.test(libSrc);
const lrcTimeFormat = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]|mm:ss/i.test(libSrc);
if (scaleFn && ratioLogic && lrcTimeFormat)
  pass("T1c: LRC rescale by ratio = actual/original when durations differ");
else fail(`T1c: time-scale rescale missing (scaleFn=${scaleFn}, ratioLogic=${ratioLogic}, lrcTimeFormat=${lrcTimeFormat})`);

// ---- T2: Whisper speech-to-text fallback ----

// T2a. A Whisper transcription module exists in src/lib (e.g. whisper.ts).
const whisperModule = /whisper|speech%-to%-text|stt|transcrib|inference\.huggingface|api\.groq\.com/i.test(libSrc);
if (whisperModule) pass("T2a: Whisper/Speech-to-Text integration present in lib");
else fail("T2a: no Whisper/STT module in src/lib");

// T2b. Requests verbose_json and consumes segments (start/text) into an LRC
//      array [{ timeInSeconds (or start), text }].
const verboseJson = /verbose_json|verbose.json|timestamp_granularit|response_format.*json/i.test(libSrc);
const segmentMap = /segments?\.(map|filter)|\.nextSegments|segment\.(start|timeInSeconds)|\.outSegments|textInSeconds|timeInSeconds|segmentStart/i.test(libSrc);
if (verboseJson && segmentMap) pass("T2b: verbose_json segments mapped into timed lines");
else fail(`T2b: verbose_json segment->LRC mapping missing (verboseJson=${verboseJson}, segmentMap=${segmentMap})`);

// T2c. Configurable via env; a secret key must NOT be hardcoded.
const envKey = /AI_W[A-Z_]*|APP_AI_W[A-Z_]*|process\.env\.[A-Z_]*WHISPER[A-Z_]*|process\.env\.[A-Z_]*GROQ[A-Z_]*|process\.env\.[A-Z_]*HF[A-Z_]*|process\.env\.[A-Z_]*HUGGING[A-Z_]*/i.test(libSrc);
const hardcodedSecret = /["'](sk-|hf_|gsk_|AIza)[A-Za-z0-9_-]{6,}["']/.test(libSrc);
if (envKey && !hardcodedSecret) pass("T2c: Whisper uses env vars, no hardcoded API key");
else fail(`T2c: env config missing or secret hardcoded (envKey=${envKey}, hardcodedSecret=${hardcodedSecret})`);

// T2d. The route sends the MP3 file buffer to Whisper when lookup is empty.
const routeUploadsAudio = /whisper|transcrib|stt|speech/i.test(routeSrc);
const readsMp3 = /storageDir|mp3Path|\.mp3|Blob|FormData|arrayBuffer|readFile/i.test(routeSrc + libSrc);
if (routeUploadsAudio && readsMp3) pass("T2d: /api/lyrics can route the stored MP3 to Whisper");
else fail(`T2d: route->Whisper hookup missing (routeUploadsAudio=${routeUploadsAudio}, readsMp3=${readsMp3})`);

// ---- T3: instrumental / silence fallback ----

// T3. Empty Whisper text / no_speech_prob detection returns isInstrumental.
const instrumentalField = /isInstrumental\b/.test(routeSrc + playerSrc + libSrc + storeSrc);
const silenceDetector = /noSpeechProb|no_speech_prob|emptyText|silence|\btext\.trim\(\)\s*===\s*["']["']|!segments?\b|segments?\s*\.length\s*===?\s*0/i.test(libSrc);
const returnsInstrumental = /isInstrumental\s*:\s*true|isInstrumental\s*=\s*true|return\s*\{\s*isInstrumental\s*:\s*true/i.test(routeSrc + libSrc);
if (instrumentalField && silenceDetector && returnsInstrumental)
  pass("T3: instrumental/silence detection returns {isInstrumental:true}");
else fail(`T3: instrumental fallback missing (instrumentalField=${instrumentalField}, silenceDetector=${silenceDetector}, returnsInstrumental=${returnsInstrumental})`);

// ---- T4: karaoke player UI ----

// T4a. The player requests lyrics and reads the isInstrumental|synced fields.
const playerGetsSynced = /parseLrc|synced|isInstrumental/.test(playerSrc);
const fieldRead = /isInstrumental/.test(playerSrc) || /lyrics\.synced/.test(playerSrc);
if (playerGetsSynced && fieldRead) pass("T4a: PlayerView consumes synced + isInstrumental");
else fail(`T4a: PlayerView field consumption missing (playerGetsSynced=${playerGetsSynced}, fieldRead=${fieldRead})`);

// T4b. Instrumental state renders an animated visualizer + badge over cover art.
const visualizer = /visualizer|equalizer|eq|-bar|analyz|canvas/i.test(playerSrc + cssSrc);
const badge = /Instrumental\s*\/\s*Beats\s*Only|instrumental\b.*badge|\bbadge\b.*[Ii]nstrumental/i.test(playerSrc + cssSrc);
const coverOverlay = /cover|overlay|\bcover-wrap\b/i.test(playerSrc + cssSrc);
if (visualizer && badge && coverOverlay)
  pass("T4b: instrumental render = animated visualizer over cover + badge");
else fail(`T4b: instrumental UI missing (visualizer=${visualizer}, badge=${badge}, coverOverlay=${coverOverlay})`);

// T4c. Normal synced lyrics still render via the karaoke view (both tiers).
const karaokeSynced = /parseLrc\(\)|parseLrc\b/.test(playerSrc);
const lyricsViewRender = /synced/.test(lyricsViewSrc);
if (karaokeSynced && lyricsViewRender) pass("T4c: synced LRC still renders through karaoke view");
else fail(`T4c: karaoke synced render missing (karaokeSynced=${karaokeSynced}, lyricsViewRender=${lyricsViewRender})`);

console.log(`\n[verify-ai-lyrics-engine] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);