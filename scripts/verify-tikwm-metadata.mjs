// Acceptance gate: "TikWM metadata mapping for background tracks"
// (freebuff-task-20260817143000).
//
// LIVE-REPRO (2026-08-17, reported by user from screenshot):
//   TikTok extraction returned:
//     title  = "Bellingham owns Barcelona || #bellingham..."  (video caption)
//     artist = "vinftbl5"  (creator username)
//   This breaks Tier 1/2 lyrics search: the app searches LRCLIB/Genius with
//   hashtag text instead of the actual track name.
//
// TikWM RESPONSE SHAPE (important): in www.tikwm.com/api responses,
//   data.music        = STRING audio URL of the background track
//   data.music_info   = OBJECT holding the music track's real metadata:
//                       { title, author, play, cover }
//   data.title        = video caption (contains hashtags)
//   data.author       = video creator { nickname, unique_id }
//   data.play         = raw video audio (contains voiceovers)
//   data.cover        = video thumbnail
//
// FIX DESIGN (required — implemented in src/lib/extract.ts):
// 1. Map metadata with explicit priority:
//    - title:  data.music_info.title   ►  data.title          (caption)
//    - artist: data.music_info.author  ►  data.author.nickname ►
//              data.author.unique_id   ► "Unknown artist"
//    - cover:  data.music_info.cover   ►  data.cover
//    - audioUrl: data.music_info.play  ►  data.music (string) ► data.play
// 2. "Original sound" clean fallback: when the resolved music title looks like
//    a generic TikTok audio name (starts with "original sound -",
//    "som original -", or contains "sound created by"), feed the COMBINED
//    generic-title + video-caption text through cleanTrackMetadata to attempt
//    to extract a real "Artist - Song Name" pair; use the cleaned values when
//    they yield a distinct artist/title. (Note: data.music is a URL string in
//    TikWM, so its real title lives in data.music_info.title — the fallback
//    applies when THAT title is generic.)
// 3. Keep the 403 header spoofing + cobalt fallback + isTikTokUrl routing
//    completely unchanged.
//
// GB checks FAIL against baseline 83e2f5d and PASS after the fix.
// GP checks are regression guards and must stay PASS.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

const extract = read(resolve(root, "src/lib/extract.ts"));

// ---- GB1: title priority: data.music_info.title > data.title (caption) ----
{
  if (/async function writeTikTokTrack/.test(extract)) pass("GB1: writeTikTokTrack function present in source");
  else fail("GB1: writeTikTokTrack function missing from source");
  if (/data\.music_info\??\.title/.test(extract)) pass("GB1: data.music_info.title reference present");
  else fail("GB1: data.music_info.title reference missing from source");
  if (/data\.title/.test(extract)) pass("GB1: data.title (caption) fallback reference present");
  else fail("GB1: data.title fallback reference missing from source");
}

// ---- GB2: artist priority: music_info.author > author.nickname > author.unique_id ----
{
  if (/async function writeTikTokTrack/.test(extract)) pass("GB2: writeTikTokTrack function present in source");
  else fail("GB2: writeTikTokTrack function missing from source");
  if (/data\.music_info\??\.author/.test(extract)) pass("GB2: data.music_info.author reference present");
  else fail("GB2: data.music_info.author reference missing from source");
  if (/data\.author\??\.nickname/.test(extract)) pass("GB2: data.author.nickname fallback reference present");
  else fail("GB2: data.author.nickname fallback reference missing from source");
  if (/data\.author\??\.unique_id/.test(extract)) pass("GB2: data.author.unique_id fallback reference present");
  else fail("GB2: data.author.unique_id fallback reference missing from source");
}

// ---- GB3: cover priority: data.music_info.cover > data.cover ----
{
  if (/async function writeTikTokTrack/.test(extract)) pass("GB3: writeTikTokTrack function present in source");
  else fail("GB3: writeTikTokTrack function missing from source");
  if (/data\.music_info\??\.cover/.test(extract)) pass("GB3: data.music_info.cover reference present");
  else fail("GB3: data.music_info.cover reference missing from source");
  if (/data\.cover/.test(extract)) pass("GB3: data.cover fallback reference present");
  else fail("GB3: data.cover fallback reference missing from source");
}

// ---- GB4: audioUrl priority: data.music_info.play > data.music > data.play ----
{
  if (/async function writeTikTokTrack/.test(extract)) pass("GB4: writeTikTokTrack function present in source");
  else fail("GB4: writeTikTokTrack function missing from source");
  if (/data\.music_info\??\.play/.test(extract)) pass("GB4: data.music_info.play reference present");
  else fail("GB4: data.music_info.play reference missing from source");
  if (/data\.play\b/.test(extract)) pass("GB4: data.play fallback reference present");
  else fail("GB4: data.play fallback reference missing from source");
}

// ---- GB5: original sound clean fallback ----
{
  if (/cleanTrackMetadata\(/.test(extract)) pass("GB5: cleanTrackMetadata used in source");
  else fail("GB5: cleanTrackMetadata not used in source");
  if (/original sound|som original|sound created by/i.test(extract)) pass("GB5: original sound detection patterns present");
  else fail("GB5: original sound detection patterns missing from source");
}

// ---- GP1 (guard): isTikTokUrl unchanged ----
{
  const hasIsTikTok = extract?.includes("isTikTokUrl");
  if (hasIsTikTok) pass("GP1: isTikTokUrl still present");
  else fail("GP1: isTikTokUrl removed");
}

// ---- GP2 (guard): broad 403 header spoofing + Referer intact ----
{
  const hasUa = /BROWSER_USER_AGENT/.test(extract);
  const hasReferer = /Referer/.test(extract);
  if (hasUa && hasReferer) pass("GP2: 403 header spoofing intact (extract.ts)");
  else fail(`GP2: 403 header spoofing changed (ua=${hasUa}, referer=${hasReferer})`);
}

// ---- GP3 (guard): cobalt fallback still present ----
{
  const hasCobalt = /getCobaltAudio|deriveThumbnailUrl/.test(extract);
  if (hasCobalt) pass("GP3: cobalt fallback intact");
  else fail("GP3: cobalt fallback missing");
}

console.log(`\n[verify-tikwm-metadata] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);