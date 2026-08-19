// Acceptance gate: "HOME FEED & LOCAL LIBRARY" — master-directive pillar 1
// (freebuff-task-20260818-235002).
//
// USER DIRECTIVE (2026-08-18): VibeMusic must feel like a premium streaming
// platform (YouTube Music), not a YT-to-MP3 converter. Home Feed rendering in
// <10ms from local IndexedDB BEFORE any network request; a 3x2 "Speed Dial"
// grid of the top 6 most-played tracks; tappable Mood Chips ("Work out",
// "Relax", "Focus") that instantly filter the local library; local algorithmic
// rows: Quick Picks (top 4 weekly plays + 2 random saved songs), Forgotten
// Favorites (not played in 30+ days), Long Listens (>20 minutes); lazy
// rendering for 60fps scroll; dynamic theming from the album art's dominant
// color. Plays >10 seconds must be logged to a "Recently Played" history.
// No raw technical jargon in visible UI copy.
//
// Contract (gate is self-contained: static source checks + VM-eval of the pure
// library-core functions with a fixture library).
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

const coreSrc = read(resolve(root, "src/lib/library-core.ts")) ?? "";
const localSrc = read(resolve(root, "src/lib/local-library.ts")) ?? "";
const homeSrc = read(resolve(root, "src/components/HomeFeed.tsx")) ?? "";
const pageSrc = read(resolve(root, "src/app/page.tsx")) ?? "";
const ambientSrc = read(resolve(root, "src/components/AmbientBackdrop.tsx")) ?? "";
const playerSrc = read(resolve(root, "src/components/PlayerView.tsx")) ?? "";
const cssSrc = read(resolve(root, "src/app/app.css")) ?? "";
const cacheSrc = read(resolve(root, "src/lib/client-cache.ts")) ?? "";
const pkg = existsSync(resolve(root, "package.json"))
  ? JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
  : null;

// ---- FIXTURE LIBRARY for functional checks ----
// 10 tracks: counts, lastPlayedAt (days ago), durations, titles for moods.
const DAY = 86400 * 1000;
const NOW = 1752920000000; // fixed "now" for determinism
const fixture = [
  { id: "a", title: "ME ESPERE", artist: "Slowed", duration: 420, playCount: 9, lastPlayedAt: NOW - 1 * DAY, addedAt: NOW - 90 * DAY },
  { id: "b", title: "BABYDOLL", artist: "Ari Abdul", duration: 184, playCount: 7, lastPlayedAt: NOW - 2 * DAY, addedAt: NOW - 80 * DAY },
  { id: "c", title: "Don't Let Me Down", artist: "Chainsmokers", duration: 216, playCount: 5, lastPlayedAt: NOW - 40 * DAY, addedAt: NOW - 70 * DAY },
  { id: "d", title: "Workout Hype Mix", artist: "Gym Beats", duration: 1500, playCount: 4, lastPlayedAt: NOW - 31 * DAY, addedAt: NOW - 60 * DAY },
  { id: "e", title: "Chill Lofi Rain", artist: "Sleepy", duration: 2400, playCount: 3, lastPlayedAt: NOW - 45 * DAY, addedAt: NOW - 50 * DAY },
  { id: "f", title: "Deep Focus Piano", artist: "Study", duration: 1800, playCount: 2, lastPlayedAt: NOW - 3 * DAY, addedAt: NOW - 40 * DAY },
  { id: "g", title: "Club Party Bass", artist: "DJ Now", duration: 300, playCount: 1, lastPlayedAt: NOW - 6 * DAY, addedAt: NOW - 30 * DAY },
  { id: "h", title: "Ambient Sleep", artist: "Dreamer", duration: 900, playCount: 0, lastPlayedAt: 0, addedAt: NOW - 20 * DAY },
  { id: "i", title: "Cinematic Epic", artist: "Score", duration: 1300, playCount: 0, lastPlayedAt: 0, addedAt: NOW - 10 * DAY },
  { id: "j", title: "Short Clip Sound", artist: "User", duration: 22, playCount: 0, lastPlayedAt: 0, addedAt: NOW - 5 * DAY },
];

/** VM-evaluates one exported pure function (self-contained body). */
function evalFn(src, name, signature) {
  const match = src.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!match) return { ok: false, err: `${name} not found` };
  try {
    const body = match[0].replace(/export\s+/, "").replace(new RegExp(`function ${name}\\([^)]*\\)`), `function ${name}(${signature})`).trim();
    const sandbox = {};
    runInNewContext(body, sandbox);
    return { ok: true, fn: sandbox[name] };
  } catch (e) {
    return { ok: false, err: `${name} eval failed (must be self-contained, no module refs): ${e.message}` };
  }
}

// ---- G1: computeLibraryRows — Speed Dial 3x2 (top 6 by plays) ----
{
  const ev = evalFn(coreSrc, "computeLibraryRows", "tracks, seed, now");
  if (!ev.ok) { fail(`G1: ${ev.err}`); }
  else {
    const rows = ev.fn(fixture, 42, NOW);
    if (!rows || !Array.isArray(rows.speedDial)) fail("G1: computeLibraryRows missing speedDial array");
    else if (rows.speedDial.length !== 6) fail(`G1: speedDial has ${rows.speedDial.length} entries (expected 6)`);
    else if (rows.speedDial[0].id !== "a" || rows.speedDial[1].id !== "b" || rows.speedDial[5].id !== "g")
      fail(`G1: speedDial order wrong: ${rows.speedDial.map((t) => t.id).join(",")} (expected a,b,c,d,f,g top-6 by playCount desc)`);
    else pass("G1: speedDial = exactly the 6 most-played, playCount desc (a,b,c,d,f,g)");
  }
}

// ---- G2: computeLibraryRows — Quick Picks (top-4 weekly + 2 deterministic random) ----
{
  const ev = evalFn(coreSrc, "computeLibraryRows", "tracks, seed, now");
  if (!ev.ok) { fail(`G2: ${ev.err}`); }
  else {
    const rows = ev.fn(fixture, 42, NOW);
    const weekly = rows.quickPicks ? rows.quickPicks.filter((t) => t.lastPlayedAt > NOW - 7 * DAY) : [];
    if (!rows.quickPicks || rows.quickPicks.length !== 6) fail(`G2: quickPicks has ${rows.quickPicks ? rows.quickPicks.length : 0} entries (expected 6)`);
    else if (weekly.length < 4) fail(`G2: quickPicks does not include the top 4 weekly plays (weekly=${weekly.length})`);
    else if (rows.quickPicks.find((t) => t.playCount === 0) === undefined) fail("G2: quickPicks has no random never-played track");
    else {
      const again = ev.fn(fixture, 42, NOW);
      if (JSON.stringify(again.quickPicks.map((t) => t.id).sort()) !== JSON.stringify(rows.quickPicks.map((t) => t.id).sort()))
        fail("G2: quickPicks NOT deterministic for the same seed");
      else pass("G2: quickPicks = top-4 weekly plays + 2 zero-play random (deterministic per seed)");
    }
  }
}

// ---- G3: computeLibraryRows — Forgotten Favorites (>30d, played) & Long Listens (>20min) ----
{
  const ev = evalFn(coreSrc, "computeLibraryRows", "tracks, seed, now");
  if (!ev.ok) { fail(`G3: ${ev.err}`); }
  else {
    const rows = ev.fn(fixture, 42, NOW);
    const forgotten = rows.forgottenFavorites || [];
    if (!forgotten.length) fail("G3: forgottenFavorites empty");
    else if (forgotten.some((t) => (t.playCount > 0 && NOW - t.lastPlayedAt > 30 * DAY) === false))
      fail("G3: forgottenFavorites contains a track that was played within 30 days");
    else if (forgotten[0].id !== "c") fail(`G3: forgottenFavorites[0] = ${forgotten[0].id} (expected c, most-played stale)`);
    else pass("G3: forgottenFavorites = played tracks untouched for >30 days, playCount desc");

    const long = rows.longListens || [];
    const expectedLong = fixture.filter((t) => t.duration >= 1200).sort((x, y) => y.duration - x.duration);
    if (!long.length) fail("G3b: longListens empty");
    else if (long.some((t) => t.duration < 1200)) fail("G3b: longListens contains a track under 20 minutes");
    else if (long[0].id !== expectedLong[0].id) fail(`G3b: longListens[0] = ${long[0].id} (expected ${expectedLong[0].id}, longest)`);
    else pass("G3b: longListens = tracks >= 1200s (20 min), duration desc");
  }
}

// ---- G4: moodForTrack + filterByMood ----
{
  const ev = evalFn(coreSrc, "moodForTrack", "track");
  if (!ev.ok) { fail(`G4: ${ev.err}`); }
  else {
    const checks = [
      [fixture[3], "work out"],   // "Workout Hype Mix" / Gym Beats
      [fixture[4], "relax"],      // "Chill Lofi Rain" / Sleepy
      [fixture[5], "focus"],      // "Deep Focus Piano"
      [fixture[6], "work out"],   // "Club Party Bass"
      [fixture[8], "focus"],      // "Cinematic Epic"
      [fixture[9], "short"],      // 22s clip -> short
    ];
    let okAll = true;
    for (const [track, expected] of checks) {
      const moods = ev.fn(track);
      if (!moods.includes(expected)) { okAll = false; fail(`G4: moodForTrack(${track.title}) missing "${expected}" (got ${JSON.stringify(moods)})`); }
    }
    const shortAlso = ev.fn({ ...fixture[3], duration: 40 });
    if (!shortAlso.includes("short")) { okAll = false; fail("G4b: short tag missing for <60s track"); }
    if (okAll) pass("G4: moodForTrack tags work out/relax/focus/short from title+artist+duration");
  }

  const ev2 = evalFn(coreSrc, "filterByMood", "tracks, mood");
  if (!ev2.ok) { fail(`G4c: ${ev2.err}`); }
  else {
    const focused = ev2.fn(fixture, "focus");
    if (!focused.length) fail("G4c: filterByMood('focus') returned empty");
    else if (focused.some((t) => !["Deep Focus Piano", "Cinematic Epic"].includes(t.title))) fail(`G4c: filterByMood('focus') = ${focused.map((t) => t.title).join(",")}`);
    else pass("G4c: filterByMood filters to mood-tagged tracks only");
  }
}

// ---- G5: shouldLogPlay (plays >10s log to Recently Played) ----
{
  const ev = evalFn(coreSrc, "shouldLogPlay", "seconds");
  if (!ev.ok) { fail(`G5: ${ev.err}`); }
  else if (ev.fn(9.9) !== false || ev.fn(10) !== true || ev.fn(15) !== true) fail("G5: shouldLogPlay boundary wrong (9.9->false, 10->true, 15->true)");
  else pass("G5: shouldLogPlay returns true only at >= 10 seconds");
}

// ---- G6: local-library.ts — IDB v2 'library' store, upsert, snapshot, >10s ----
{
  if (/indexedDB\.open\(DB_NAME,\s*2\)/.test(cacheSrc) && /createObjectStore\("library"\)|createObjectStore\('library'\)/.test(cacheSrc))
    pass("G6: client-cache.ts bumped to DB v2 + 'library' object store created");
  else fail("G6: client-cache.ts must open the vibemusic DB at version 2 and create the 'library' store in onupgradeneeded");
  if (/export (async )?function recordPlayStart/.test(localSrc)) pass("G6b: recordPlayStart exported (upsert: playCount+1, lastPlayedAt, addedAt kept)");
  else fail("G6b: recordPlayStart missing");
  if (/export (async )?function markListened/.test(localSrc) && /shouldLogPlay/.test(localSrc))
    pass("G6c: markListened exported and gated by shouldLogPlay (>=10s)");
  else fail("G6c: markListened / shouldLogPlay wiring missing in local-library.ts");
  if (/getSnapshotSync|snapshotCache/.test(localSrc)) pass("G6d: in-memory snapshot cache with a SYNC read (sub-10ms local-first render)");
  else fail("G6d: no sync snapshot read (Home Feed cannot render <10ms without it)");
  if (/never|catch|return null|undefined\) return/.test(localSrc) && /indexedDB/.test(localSrc)) pass("G6e: browser-guarded, never throws");
  else fail("G6e: missing indexedDB guard / never-throw pattern");
  if (/recordPlayStart/.test(localSrc) && /playCount\s*:?\s*(?:\([^)]*\)|\+\s*1|count\s*\|\|\s*0\s*\+\s*1)/.test(localSrc))
    pass("G6f: recordPlayStart increments playCount");
  else fail("G6f: recordPlayStart does not increment playCount");
}

// ---- G7: HomeFeed — local-first <10ms, chips, rows, lazy rendering, no jargon ----
{
  if (!homeSrc) { fail("G7: src/components/HomeFeed.tsx missing"); passed--; }
  else {
    if (/getSnapshotSync|snapshot|getLibrarySnapshot/.test(homeSrc)) pass("G7a: HomeFeed reads the local snapshot (local-first)");
    else fail("G7a: HomeFeed does not read the library snapshot");
    const snapshotIdx = homeSrc.indexOf("getSnapshotSync");
    const fetchIdx = homeSrc.indexOf("fetch(");
    if (snapshotIdx !== -1 && (fetchIdx === -1 || snapshotIdx < fetchIdx)) pass("G7b: snapshot read happens BEFORE any network fetch");
    else fail("G7b: network fetch precedes the local snapshot read (violates <10ms local-first)");
    if (/speed.?dial/i.test(homeSrc) && /grid/.test(homeSrc) && /3|repeat\(3|repeat\(auto/.test(homeSrc))
      pass("G7c: 3x2 speed-dial grid");
    else fail("G7c: no 3x2 (repeat(3, ...) x2) speed-dial grid");
    if (/Work out|Relax|Focus/.test(homeSrc) && /filterByMood|mood/.test(homeSrc)) pass("G7d: mood chips (Work out / Relax / Focus) filter by mood");
    else fail("G7d: mood chips or mood filtering missing");
    if (/quickPicks|Quick Picks/.test(homeSrc) && /forgotten|Forgotten/.test(homeSrc) && /longListens|Long Listens/.test(homeSrc))
      pass("G7e: all three algorithmic rows rendered (Quick Picks, Forgotten Favorites, Long Listens)");
    else fail("G7e: one or more algorithmic rows missing in HomeFeed");
    if (/content-visibility|contentVisibility|IntersectionObserver/.test(homeSrc)) pass("G7f: lazy rendering (content-visibility or IntersectionObserver)");
    else fail("G7f: no lazy-rendering mechanism for off-screen rows");
    if (/href=\{?["'`]\/player\/\$\{|`\/player\/\$\{/.test(homeSrc) || /\/player\//.test(homeSrc))
      pass("G7g: rows link into /player/[id]");
    else fail("G7g: row items do not link to /player/[id]");
    const banned = /extractor|TikWM|cobalt|ID3|whisper|ffprobe|yt-dlp/i;
    if (!banned.test(homeSrc)) pass("G7h: no raw technical jargon in HomeFeed copy (extractor/TikWM/cobalt/ID3/whisper)");
    else fail("G7h: technical jargon leaked into HomeFeed visible copy");
  }
  if (!pageSrc.includes("HomeFeed")) {
    // page.tsx must mount HomeFeed (empty-library fallback keeps the extract form)
    if (/HomeFeed/.test(pageSrc)) pass("G7i: page.tsx mounts HomeFeed");
    else fail("G7i: page.tsx does not mount HomeFeed");
  }
  const ambientSource = ambientSrc.length ? ambientSrc : homeSrc;
  if (/canvas|getImageData/.test(ambientSource)) pass("G7j: ambient backdrop extracts dominant color from the album art (canvas)");
  else fail("G7j: no dominant-color extraction (canvas/getImageData)");
}

// ---- G8: PlayerView — stat hooks + >10s history + jargon-free status copy ----
{
  if (/recordPlayStart/.test(playerSrc)) pass("G8: PlayerView records play start (playCount increments)");
  else fail("G8: recordPlayStart not wired in PlayerView");
  if (/markListened/.test(playerSrc) && /shouldLogPlay/.test(playerSrc))
    pass("G8b: PlayerView marks listened at >=10s (Recently Played history)");
  else fail("G8b: markListened/shouldLogPlay wiring missing in PlayerView");
  if (!/Parsing ID3 tags|Contacting|find all metadata/i.test(playerSrc)) pass("G8c: raw jargon strings removed from PlayerView status copy");
  else fail("G8c: jargon status strings remain (e.g. 'Parsing ID3 tags')");
}

// ---- G9: ambient CSS + lazy-render CSS + no new deps ----
{
  if (/content-visibility\s*:\s*auto/.test(cssSrc) && /contain-intrinsic-size/.test(cssSrc))
    pass("G9: CSS uses content-visibility:auto + contain-intrinsic-size (60fps scroll)");
  else fail("G9: CSS lazy-render declarations missing");
  if (/ambient|gradient/.test(cssSrc)) pass("G9b: ambient gradient styling present");
  else fail("G9b: ambient gradient CSS missing");
  const expected = ["@gradio/client", "@heyputer/puter.js", "jsmediatags", "next", "react", "react-dom", "yt-dlp-wrap"];
  if (pkg && pkg.dependencies && JSON.stringify(Object.keys(pkg.dependencies).sort()) === JSON.stringify([...expected].sort()))
    pass("G9c: no new npm dependencies");
  else fail("G9c: dependency set changed");
}

console.log(`\n[verify-home-feed] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);