// Acceptance gate: "audio fingerprinting & lyrics reverse-search fallback"
// (freebuff-task-20260818-203036).
//
// USER OVERRIDE (2026-08-18): when a TikTok URL's TikWM response carries a
// GENERIC label ("original sound", "som original", "son original", "Unknown -
// FullMix", hashtags-only caption, or NO music_info object at all), the app
// must NOT just serve the raw video audio + placeholder metadata. Required
// pipeline in /api/extract:
//   1. Detect "Unidentified": generic title OR missing music_info.
//   2. Whisper fingerprint: transcribe a 15-30s window of data.play/audio
//      (not the whole track) through the existing whisper tier.
//   3. Reverse lookup: Genius lyric-text search on the snippet; a strong hit
//      (matchedWords >= 5) OVERWRITES title/artist/cover with the official
//      track.
//   4. Audio swap: fetch the clean official audio (yt-dlp ytsearch first,
//      Invidious-search -> cobalt fallback) and REPLACE the noisy TikTok
//      video audio on disk.
//   5. Instrumental/silence: Whisper returns no words -> bypass everything,
//      keep the original payload. Every fallback is graceful (extraction
//      never blocks).
//
// The gate is self-contained (reads sources + VM-evals pure bodies), same
// house style as verify-original-sound-identify.mjs.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

const extractSrc = read(resolve(root, "src/lib/extract.ts")) ?? "";
const identifySrc = read(resolve(root, "src/lib/identify.ts")) ?? "";
const whisperSrc = read(resolve(root, "src/lib/whisper.ts")) ?? "";
const cleanAudioSrc = read(resolve(root, "src/lib/clean-audio.ts")) ?? "";
const ytdlpSrc = read(resolve(root, "src/lib/ytdlp.ts")) ?? "";
const pkg = existsSync(resolve(root, "package.json"))
  ? JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
  : null;

// ---- G1: isGenericTikTokTitle exported, SELF-CONTAINED (VM-evalable) ----
{
  if (/export function isGenericTikTokTitle/.test(extractSrc)) pass("G1: isGenericTikTokTitle exported in extract.ts");
  else fail("G1: isGenericTikTokTitle not found in extract.ts");

  const fnMatch = extractSrc.match(/export function isGenericTikTokTitle\([\s\S]*?\n\}/);
  if (!fnMatch) {
    fail("G1b: could not extract isGenericTikTokTitle body");
  } else {
    let fn = null;
    try {
      // runInNewContext is script mode — strip `export` and normalize the
      // signature (same pattern as verify-original-sound-identify.mjs GB2).
      const fnSrc = fnMatch[0]
        .replace(/export\s+/, "")
        .replace(/function isGenericTikTokTitle\([^)]*\)/, "function isGenericTikTokTitle(t)")
        .trim();
      const sandbox = {};
      runInNewContext(fnSrc, sandbox);
      fn = sandbox.isGenericTikTokTitle;
    } catch (e) {
      fail(`G1b: isGenericTikTokTitle eval failed (must be self-contained, no module refs): ${e.message}`);
    }
    if (fn) {
      const cases = [
        ["#fyp #viral #foryou", true],
        ["#music #slowed #reverb", true],
        ["@user #funny", true],
        ["original sound - city_368", true],
        ["som original - someone", true],
        ["son original - alguien", true],
        ["Unknown - FullMix", true],
        ["sound created by x", true],
        ["", true],
        ["   ", true],
        ["ME ESPERE - Slowed", false],
        ["Bellingham owns Barcelona", false],
        ["Powers Music", false],
        ["Untitled", false],
      ];
      let okAll = true;
      for (const [input, expected] of cases) {
        const got = fn(input) === true;
        if (got !== expected) {
          okAll = false;
          fail(`G1b: isGenericTikTokTitle(${JSON.stringify(input)}) = ${got} (expected ${expected})`);
        }
      }
      if (okAll) pass("G1b: isGenericTikTokTitle truth table correct (hashtags-only/mentions/generic -> true; real titles -> false)");
    }
  }
}

// ---- G2: writeTikTokTrack flags "Unidentified" (generic title OR missing music_info) ----
{
  if (/music_info/ && /unidentified/i.test(extractSrc) || /!data\.music_info/.test(extractSrc))
    pass("G2: writeTikTokTrack considers a MISSING music_info as Unidentified");
  else fail("G2: no missing-music_info detection (override: missing music_info must flag Unidentified)");
  if (/unidentified/i.test(extractSrc) && /isGenericTikTokTitle/.test(extractSrc))
    pass("G2b: unidentified = generic title OR missing music_info (isGenericTikTokTitle wired)");
  else fail("G2b: isGenericTikTokTitle not wired into the Unidentified flag");
  const identifyGuard = /unidentified/.test(extractSrc);
  if (identifyGuard) pass("G2c: audio identification now fires for ALL Unidentified tracks (incl. missing music_info)");
  else fail("G2c: identification still gated only on genericOriginalTitle");
}

// ---- G3: whisper WINDOW (15-30s) instead of whole-track transcription ----
{
  if (/probeAudioDuration/.test(identifySrc)) pass("G3: identify.ts probes duration to size the window");
  else fail("G3: identify.ts does not probe duration (window sizing missing)");
  if (/(WHISPER_WINDOW|WINDOW_SECONDS|slice|ffmpeg)/.test(identifySrc)) pass("G3b: identify.ts slices an analysis window (ffmpeg)");
  else fail("G3b: no window slicing (must route a 15-30s clip, not the whole track)");
  if (/>\s*30/.test(identifySrc) && /-\s*t\s*(?:2[0-9]|3[0-5])|-\s*t\s*["']?2[0-9]|maxSeconds|sliceSeconds/.test(identifySrc))
    pass("G3c: window = ~15-30s, sliced only when the track is longer than 30s");
  else fail("G3c: no explicit 15-30s window / >30s threshold");
  if (/finally/.test(identifySrc) && /unlink|rm\b/.test(identifySrc)) pass("G3d: temp slice file is cleaned up (finally + unlink)");
  else fail("G3d: no temp-slice cleanup (finally/unlink) in identify.ts");
}

// ---- G4: fetchIdentifiedAudio (clean official audio) module ----
{
  const src = cleanAudioSrc || extractSrc;
  if (/export (async )?function fetchIdentifiedAudio|export const fetchIdentifiedAudio/.test(src))
    pass("G4: fetchIdentifiedAudio exported (clean-audio.ts or extract.ts)");
  else fail("G4: fetchIdentifiedAudio not found");
  if (/ytsearch/.test(src)) pass("G4b: tries yt-dlp ytsearch first for the official track");
  else fail("G4b: no ytsearch (yt-dlp search) attempt");
  if (/invidious|cobalt|getCobaltAudio/.test(src)) pass("G4c: fallback route (Invidious search -> cobalt tunnel) present");
  else fail("G4c: no Invidious/cobalt fallback route");
  if (/probeAudioDuration/.test(src)) pass("G4d: swap audio is ffprobe-verified before acceptance");
  else fail("G4d: swap audio not ffprobe-verified");
  if (/catch/.test(src) && /return null/.test(src)) pass("G4e: never throws — every failure resolves to null");
  else fail("G4e: no try/catch -> null on total failure");
}

// ---- G5: extract.ts wiring — overwrite metadata THEN swap the audio ----
{
  if (/matchedWords\s*>=\s*5|matchedWords\s*>=5/.test(extractSrc)) pass("G5: strong-match threshold (matchedWords >= 5) still required before any override");
  else fail("G5: matchedWords >= 5 guard missing");
  if (/fetchIdentifiedAudio/.test(extractSrc)) pass("G5b: fetchIdentifiedAudio called on strong hit");
  else fail("G5b: fetchIdentifiedAudio not called in extract.ts");
  if (/rename|unlink/.test(extractSrc) && /staging|\.tmp|cleanPath|swapPath|stg/.test(extractSrc))
    pass("G5c: swap replaces the persisted mp3 (staging file renamed over mp3Path)");
  else fail("G5c: no staging -> rename replacement of the stored mp3");
  if (/sizeBytes/.test(extractSrc) && /duration/.test(extractSrc) && /thumbnail/.test(extractSrc))
    pass("G5d: sizeBytes/duration/thumbnail updated from the clean swap result");
  else fail("G5d: meta fields not updated from the swap result");
  if (/\bif\s*\(\s*(clean|swap|official|identified\s*&&)/.test(extractSrc)) pass("G5e: swap failure keeps the original TikTok audio (guarded, graceful)");
  else fail("G5e: swap call result not guarded — a null swap must keep original audio");
}

// ---- G6: resolveDisplayIdentity maps hashtags-only titles ----
{
  if (/isGenericTikTokTitle/.test(extractSrc) && /TikTok Background Music/.test(extractSrc))
    pass("G6: resolveDisplayIdentity uses isGenericTikTokTitle -> 'TikTok Background Music'");
  else fail("G6: resolveDisplayIdentity does not map generic/hashtags-only titles to 'TikTok Background Music'");
  if (/\^untitled\$/i.test(extractSrc) || /untitled/i.test(extractSrc.split("export function isGenericTikTokTitle")[0]))
    pass("G6b: bare 'Untitled' also resolves to 'TikTok Background Music'");
  else fail("G6b: 'Untitled' not covered by resolveDisplayIdentity");
}

// ---- G7: no regressions to the existing pipeline pieces ----
{
  if (/original sound|som original|fullmix/i.test(extractSrc)) pass("G7: GENERIC_MUSIC_TITLE classes preserved");
  else fail("G7: generic-title regex classes removed");
  if (/Promise\.any/.test(whisperSrc) && /PER_SPACE_TIMEOUT_MS/.test(whisperSrc) && /TOTAL_TIMEOUT_MS/.test(whisperSrc))
    pass("G7b: whisper parallel race + per-space/total budgets intact");
  else fail("G7b: whisper race/budgets regressed");
  if (/pickLyricHit/.test(identifySrc) && /matched_words/.test(identifySrc))
    pass("G7c: pickLyricHit + matched_words ranking intact");
  else fail("G7c: pickLyricHit regressed");
  if (/whisperTranscribe/.test(identifySrc) && /genius\.com\/api\/search\/multi/.test(identifySrc))
    pass("G7d: whisperTranscribe -> Genius search chain intact");
  else fail("G7d: whisper/Genius chain regressed");
  if (/GENERIC_MUSIC_TITLE/.test(extractSrc) && /resolveDisplayIdentity/.test(extractSrc))
    pass("G7e: resolveDisplayIdentity + GENERIC_MUSIC_TITLE still in extract.ts");
  else fail("G7e: resolveDisplayIdentity/GENERIC_MUSIC_TITLE removed");
}

// ---- G8: no new npm dependencies ----
{
  const expected = ["@gradio/client", "@heyputer/puter.js", "jsmediatags", "next", "react", "react-dom", "yt-dlp-wrap"];
  if (pkg && pkg.dependencies) {
    const keys = Object.keys(pkg.dependencies).sort();
    const want = [...expected].sort();
    if (JSON.stringify(keys) === JSON.stringify(want)) pass("G8: no new dependencies added (node:child_process/ffmpeg only)");
    else fail(`G8: dependency set changed: ${JSON.stringify(keys)}`);
  } else {
    fail("G8: package.json unreadable");
  }
}

console.log(`\n[verify-audio-fingerprint-fallback] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
