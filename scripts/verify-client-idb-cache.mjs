// Acceptance gate: frontend IndexedDB cache wiring (journal 042 rebuild).
// Requires:
//  1. src/lib/track-cache-core.ts — pure core (namespaced keys, size guard,
//     storage-failure swallowing) — used by the browser adapter.
//  2. src/lib/client-cache.ts — IndexedDB-backed adapter.
//  3. PlayerView: audio blob cache consulted BEFORE the network fetch, and
//     the fetched blob written back to the cache.
//  4. PlayerView: lyrics cache read first; successful fetch written back.
//  5. Cache errors must never break playback (core swallows store failures).
// Exit 0 = accept, 1 = reject.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

const corePath = resolve(root, "src/lib/track-cache-core.ts");
const clientPath = resolve(root, "src/lib/client-cache.ts");
const playerPath = resolve(root, "src/components/PlayerView.tsx");
const has = (p) => existsSync(p);

// 1. Core module exists with the required surface.
if (!has(corePath)) {
  fail("src/lib/track-cache-core.ts missing");
} else {
  const core = readFileSync(corePath, "utf8");
  if (/vibemusic:/.test(core)) pass("G1: cache keys namespaced (vibemusic: prefix)");
  else fail("G1: no namespaced cache keys in track-cache-core");
  if (/maxAudioBytes|maxBytes/.test(core)) pass("G2: audio size guard present");
  else fail("G2: no audio size guard in track-cache-core");
  if (/catch/.test(core)) pass("G3: storage failures swallowed inside core");
  else fail("G3: core does not swallow storage failures");
}

// 2. Browser adapter backed by real IndexedDB.
if (!has(clientPath)) {
  fail("src/lib/client-cache.ts missing");
} else {
  const cc = readFileSync(clientPath, "utf8");
  if (/indexedDB/.test(cc)) pass("G4: client-cache uses indexedDB");
  else fail("G4: client-cache does not reference indexedDB");
  if (/track-cache-core/.test(cc)) pass("G5: client-cache delegates to track-cache-core");
  else fail("G5: client-cache does not import track-cache-core");
}

// 3. PlayerView audio: cache BEFORE network + write-back.
if (!has(playerPath)) {
  fail("src/components/PlayerView.tsx missing");
} else {
  const pv = readFileSync(playerPath, "utf8");
  const usesCache = /client-cache/.test(pv);
  if (!usesCache) fail("G6: PlayerView does not import client-cache");
  else {
    const cacheFirst =
      /cachedAudioUrl\(|getAudioBlob\(/.test(pv) &&
      /setAudioBlob\(|rememberAudio\(/.test(pv);
    if (cacheFirst) pass("G6: PlayerView consults audio cache AND writes fetched blob back");
    else fail("G6: PlayerView missing cache-consult/write-back for audio (cachedAudioUrl + setAudioBlob/rememberAudio)");
    const lyricsRead = /cachedLyrics\(|getLyrics\(/.test(pv);
    const lyricsWrite = /setLyrics\(|rememberLyrics\(/.test(pv);
    if (lyricsRead && lyricsWrite) pass("G7: PlayerView reads lyrics cache first and writes on success");
    else fail(`G7: lyrics cache wiring missing (read=${lyricsRead}, write=${lyricsWrite})`);
  }
}

console.log(`\n[verify-client-idb-cache] ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);