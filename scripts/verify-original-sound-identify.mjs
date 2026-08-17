// Acceptance gate: "original-sound audio identification" (freebuff-task-20260817-225615).
//
// USER PROBLEM (reported 2026-08-17): a TikTok edit link (vm.tiktok.com/ZSVMJ3eLL/)
// plays a real, recognizable song from the audio, but TikTok's registry labels the
// sound "original sound - city_368" (music_info.original=true, album="") — there is
// NO licensed-track name in any metadata. After the 95a52e7 caption clean fallback,
// vibemusic displayed title="Pep_😭🩵" artist="17" (the stripped video caption +
// creator nickname) — NOT the real song. User demands: find the ACTUAL song name,
// as fast as possible.
//
// LIVE-PROOF (session agent, per-task): the downloaded MP3
// (storage/33ac7166daa53661c6ac3d17f42dba45.mp3) transcribed via vibemusic's own
// zero-key Whisper path (hf-audio/whisper-large-v3 space, 9s) yields:
//   "I need you. I need you. I need you right now... So don't let me, don't let me,
//    don't let me down."
// A zero-key Genius lyric-text search (GET /api/search/multi?q=<those words>)
// returns top_hit index="lyric", matched_words=9, nb_exact_words=9, nb_typos=0 →
// result.full_title = "Don't Let Me Down by The Chainsmokers (Ft. Daya)",
// result.id = 2416822. Fixture: scripts/fixtures/genius-lyric-search-dont-let-me-down.json
// (captured 2026-08-17, real response).
//
// FIX DESIGN (required):
// 1. NEW module src/lib/identify.ts:
//    - exported pure helper `pickLyricHit(response, opts)` that walks
//      json.response.sections[].hits[], keeps only hits with index === "lyric",
//      requires result object, ranks by matched_words (tie: nb_typos asc), and
//      returns { title, artist, matchedWords, enabled } | null. MINIMUM
//      matchedWords configurable (default 4). title = result.title,
//      artist = result.primary_artist?.name || result.artist_names.
//    - exported async `identifyTrackFromAudio(mp3Path, opts?)` that:
//      (a) reads the mp3, transcribes via whisperTranscribe (zero-key),
//      (b) if transcript has >= 8 chars of text, queries
//          "https://genius.com/api/search/multi?q=" + encodeURIComponent(text)
//          (key-free public endpoint) with a browser User-Agent and a short timeout
//          (default 12s),
//      (c) returns pickLyricHit(...) or null; NEVER throws (catches all).
// 2. Whisper tier is SLOW because transcribeViaGradio tries spaces SEQUENTIALLY:
//    the broken hf-audio/whisper-large-v3-turbo (503) + ZeroGPU-queued openai/whisper
//    consume the whole 15s budget before hf-audio/whisper-large-v3 (which answers in
//    ~9s) is ever reached → whisperTranscribe returns null in practice. FIX: fire all
//    spaces in PARALLEL (each still wrapped in its per-space 14000ms race) and take
//    the FIRST non-null success within the TOTAL 15000ms race. This preserves G4/G5
//    gate semantics (Promise.race + PER_SPACE_TIMEOUT_MS and TOTAL_TIMEOUT_MS still
//    wired) while making the fastest space win immediately.
// 3. extract.ts writeTikTokTrack wiring: when the resolved title is a generic
//    "original sound -/som original -/sound created by" AND the clean fallback did
//    NOT surface a real Artist - Song pair (no " - " separator in the cleaned title
//    or the cleaned artist is still creator/Unknown), call identifyTrackFromAudio:
//    - on a confident hit (matchedWords >= 5) OVERRIDE title/artist with the real
//      song (so Tier 1/2 lyrics search uses the actual track name),
//    - on null/weak hit keep the fallback (never block extraction).
// 4. No git operations, no file edits outside the worktree, no new external
//    dependencies (fetch only). typecheck (npx tsc --noEmit) + build must be clean
//    and the existing acceptance gates must stay green (whisper gates G1-G6 update:
//    first-space-order and 14000/15000 budgets unchanged — the parallelization must
//    not remove the per-space/total races).
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

const identifySrc = read(resolve(root, "src/lib/identify.ts")) ?? "";
const extractSrc = read(resolve(root, "src/lib/extract.ts")) ?? "";
const whisperSrc = read(resolve(root, "src/lib/whisper.ts")) ?? "";
const fixturePath = resolve(root, "scripts/fixtures/genius-lyric-search-dont-let-me-down.json");
const fixture = existsSync(fixturePath) ? JSON.parse(readFileSync(fixturePath, "utf8")) : null;

// ---- GB1: identify.ts exists with the pure pickLyricHit helper ----
{
  if (identifySrc.includes("pickLyricHit")) pass("GB1: pickLyricHit exported in src/lib/identify.ts");
  else fail("GB1: pickLyricHit not found in src/lib/identify.ts");
  if (identifySrc.includes("index") && identifySrc.includes("lyric")) pass("GB1b: filters hits by index === 'lyric'");
  else fail("GB1b: no lyric-index filtering in pickLyricHit");
  if (identifySrc.includes("matched_words")) pass("GB1c: ranks by matched_words");
  else fail("GB1c: no matched_words ranking in pickLyricHit");
}

// ---- GB2 (FUNCTIONAL): pickLyricHit executed on the REAL fixture returns the song ----
{
  const fnMatch = identifySrc.match(/export function pickLyricHit\([\s\S]*?\n\}/);
  if (!fnMatch) {
    fail("GB2: couldn't extract pickLyricHit function body");
  } else {
    let fnSrc = fnMatch[0].replace(/export function pickLyricHit\([\s\S]*?\)/, "function pickLyricHit(response, opts)").trim();
    let pickLyricHit = null;
    try {
      const sandbox = {};
      runInNewContext(fnSrc, sandbox);
      pickLyricHit = sandbox.pickLyricHit;
    } catch (e) {
      fail(`GB2: pickLyricHit eval failed: ${e.message}`);
    }
    if (pickLyricHit && fixture) {
      const hit = pickLyricHit(fixture.response, { minMatchedWords: 4 });
      if (hit && /Don't Let Me Down/i.test(hit.title) && /Chainsmokers/i.test(hit.artist)) {
        pass(`GB2: real fixture resolves to "${hit.title}" by "${hit.artist}"`);
      } else {
        fail(`GB2: pickLyricHit(fixture) = ${JSON.stringify(hit)} (expected Don't Let Me Down / Chainsmokers)`);
      }
    } else if (!fixture) {
      fail("GB2: missing fixture scripts/fixtures/genius-lyric-search-dont-let-me-down.json");
    }
  }
}

// ---- GB3: identifyTrackFromAudio wires whisperTranscribe + Genius /api/search/multi ----
{
  if (/whisperTranscribe/.test(identifySrc)) pass("GB3: identifyTrackFromAudio calls whisperTranscribe");
  else fail("GB3: whisperTranscribe not referenced in identify.ts");
  if (/genius\.com\/api\/search\/multi/.test(identifySrc)) pass("GB3b: queries genius /api/search/multi");
  else fail("GB3b: genius /api/search/multi URL not referenced in identify.ts");
  if (/encodeURIComponent/.test(identifySrc)) pass("GB3c: transcript text is URL-encoded into the query");
  else fail("GB3c: no encodeURIComponent of transcript text");
  if (/Language:/.test(identifySrc) || /User-Agent/.test(identifySrc)) pass("GB3d: browser User-Agent header on the search");
  else fail("GB3d: no User-Agent header on genius search");
}

// ---- GB4: whisper tier races spaces in PARALLEL (first success wins fast) ----
{
  const parallel = /Promise\.allSettled|Promise\.any|Promise\.all\s*\(/;
  if (parallel.test(whisperSrc)) pass("GB4: whisper tier fires spaces in parallel (allSettled/any/all)");
  else fail("GB4: no parallel space execution — sequential loop keeps wasting the budget on dead spaces");
  if (/PER_SPACE_TIMEOUT_MS/.test(whisperSrc)) pass("GB4b: per-space 14000ms race still present");
  else fail("GB4b: PER_SPACE_TIMEOUT_MS removed");
  if (/TOTAL_TIMEOUT_MS/.test(whisperSrc)) pass("GB4c: TOTAL_TIMEOUT_MS 15000ms budget still present");
  else fail("GB4c: TOTAL_TIMEOUT_MS removed");
}

// ---- GB5: extract.ts wires identification into the original-sound fallback ----
{
  if (/identifyTrackFromAudio/.test(extractSrc)) pass("GB5: extract.ts imports/calls identifyTrackFromAudio");
  else fail("GB5: identifyTrackFromAudio not referenced in extract.ts");
  if (/GENERIC_MUSIC_TITLE|original sound|som original|sound created by/i.test(extractSrc))
    pass("GB5b: original-sound detection still present in extract.ts");
  else fail("GB5b: original-sound detection removed from extract.ts");
  const overrideGuard = /\/\s*-\s*\//.test(extractSrc) || /separator/.test(extractSrc) || /\.includes\(/.test(extractSrc);
  if (overrideGuard) pass("GB5c: identification only fires when no real Artist - Song separator surfaced");
  else fail("GB5c: no guard limiting identification to generic/caption-only titles");
  if (/matchedWords|hit/.test(extractSrc)) pass("GB5d: identified title/artist override the fallback on strong match");
  else fail("GB5d: no override of title/artist from the identified hit");
}

// ---- GP1 (guard): writeTikTokTrack + music_info priority unchanged ----
{
  if (/async function writeTikTokTrack/.test(extractSrc)) pass("GP1: writeTikTokTrack still present");
  else fail("GP1: writeTikTokTrack missing");
  if (/data\.music_info\??\.title/.test(extractSrc)) pass("GP1b: music_info.title priority intact");
  else fail("GP1b: music_info.title priority removed");
}

console.log(`\n[verify-original-sound-identify] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);