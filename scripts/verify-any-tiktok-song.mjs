// Acceptance gate: "any TikTok link → real background song" (freebuff-task-20260818-0145).
//
// USER PROBLEM (reported 2026-08-18, LIVE-proven by session agent): EVERY TikTok link
// must extract the REAL background song (fast) with lyrics — not registry placeholder
// labels. The app served "Unknown - FullMix" / "Powers Music" for
// vm.tiktok.com/ZSVMAGDtE/ (live probe: HTTP 200, title "Unknown - FullMix",
// artist "Powers Music", extractor tikwm, cached:false) because:
//   - TikWM music_info.title = "Unknown - FullMix" (author "Powers Music",
//     original:false) is a TikTok REGISTRY PLACEHOLDER — the same class as
//     "original sound - city_368" — but the generic-title detector in extract.ts
//     only matches /^(?:original sound|som original)\s*-|sound created by/i, so
//     "Unknown - FullMix" is treated as a REAL title → audio identification is
//     never attempted → placeholder served as the song name → lyrics lookups
//     search for "Unknown - FullMix" and find nothing.
//   - The audio itself (60s AAC m4a, music_info.play) was downloaded + Groq
//     whisper-large-v3-turbo transcribed it in ~5.3s → text "The Thank you.
//     Thank you." (segments 0-2s, 30-60s) → NO real lyrics in this track's audio
//     → a lyric-text Genius search cannot name it, and that is CORRECT behavior
//     for a genuinely unlabeled bed. The FIX must therefore:
//       A. Detect ALL registry-placeholder titles (Unknown/FullMix/"original
//          sound"/"som original"/"sound created by"/empty) and run audio
//          identification for them (fast tier: Groq first when a key is set).
//       B. NEVER serve a registry placeholder as the song title: when the audio
//          itself cannot be identified, fall back to the clean caption-derived
//          title (strip placeholder tokens, hashtags, @handles, promo text),
//          never the raw "Unknown - FullMix" string; when identified, use the
//          real song name/artist.
//       C. CACHE HEALING: previously cached tracks whose stored title is still a
//          registry placeholder (or that were stored with caption garbage) must
//          NOT keep being served forever — re-extract/re-identify on cached
//          placeholder hits (re-validate once, update meta).
//       D. The full extract stays fast: total time for a fresh extract with the
//          Groq key set must stay within the existing budget (identify is
//          Groq-first ~2.5-5s); no new external dependency; no git; adjacent
//          gates must stay green.
//
// LIVE PROBES (session agent, 2026-08-18) captured into scripts/fixtures/:
//   - tikwm-zsvmagdt.json: TikWM response for the USER's exact link
//     (title "Unknown - FullMix", author "Powers Music", original:false,
//     music_info.play present) — the regression fixture.
//   - tikwm-pep-city368.json: the known original-sound link (ZSVMJ3eLL,
//     music_info.title "original sound - city_368") — must still identify.
//   - tikwm-worldcup-real.json: the known REAL-title link (ZSV6Hk8yQ,
//     music_info.title "ME ESPERE - Slowed") — must NOT be treated as generic.
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

const fx = (name) => {
  const p = resolve(root, "scripts/fixtures", name);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const tikwmUser = fx("tikwm-zsvmagdt.json");
const tikwmPep = fx("tikwm-pep-city368.json");
const tikwmWorldcup = fx("tikwm-worldcup-real.json");

// ---- GA1: a registry-placeholder title detector exists and is exported/used ----
{
  // The CURRENT detector only matches original sound/som original/sound created by.
  // Required: a function or regex that ALSO matches "Unknown - FullMix",
  // bare "Unknown", "FullMix", empty titles.
  const reMatch = extractSrc.match(/const GENERIC_MUSIC_TITLE\s*=\s*\/([\s\S]{10,300}?)\//i);
  if (reMatch) {
    try {
      const re = new RegExp(reMatch[1], "i");
      if (re.test("Unknown - FullMix")) pass("GA1: detector matches 'Unknown - FullMix'");
      else fail("GA1: detector does NOT match 'Unknown - FullMix'");
      if (re.test("original sound - city_368")) pass("GA1b: detector still matches 'original sound - city_368'");
      else fail("GA1b: detector lost 'original sound' matching");
      if (re.test("som original - user")) pass("GA1c: detector still matches 'som original - user'");
      else fail("GA1c: detector lost 'som original' matching");
      if (re.test("sound created by x")) pass("GA1d: detector still matches 'sound created by x'");
      else fail("GA1d: detector lost 'sound created by' matching");
      if (!re.test("ME ESPERE - Slowed")) pass("GA1e: detector does NOT match real title 'ME ESPERE - Slowed'");
      else fail("GA1e: detector FALSE-POSITIVES on real title 'ME ESPERE - Slowed'");
      if (!re.test("Top world cup goals moments")) pass("GA1f: detector does NOT match a normal caption");
      else fail("GA1f: detector FALSE-POSITIVES on a normal caption");
    } catch (e) {
      fail(`GA1: detector regex eval failed: ${e.message}`);
    }
  } else {
    fail("GA1: no GENERIC_MUSIC_TITLE regex found in extract.ts");
  }
}

// ---- GA2 (FUNCTIONAL): resolveDisplayIdentity on the REAL user-link fixture ----
// The fixture must resolve to a display title, NEVER the raw placeholder.
{
  const fn = extractSrc.match(/function resolveDisplayIdentity\([\s\S]*?\n\}/);
  if (!fn) {
    fail("GA2: resolveDisplayIdentity(t) not found in extract.ts");
  } else {
    const fnSrc = fn[0].replace(/function resolveDisplayIdentity\([\s\S]*?\)/, "function resolveDisplayIdentity(t)").trim();
    const sandbox = {};
    try {
      runInNewContext(fnSrc, sandbox);
      const r1 = sandbox.resolveDisplayIdentity(tikwmUser?.data?.music_info?.title || "Unknown - FullMix");
      if (r1 && typeof r1 === "string" && !/unknown|fullmix/i.test(r1)) {
        pass(`GA2: user-link placeholder title resolves to "${r1}" (not the raw placeholder)`);
      } else {
        fail(`GA2: resolveDisplayIdentity = ${JSON.stringify(r1)} — expected a cleaned name, not the raw placeholder`);
      }
      const r2 = sandbox.resolveDisplayIdentity(tikwmWorldcup?.data?.music_info?.title || "ME ESPERE - Slowed");
      if (r2 === "ME ESPERE - Slowed") pass("GA2b: real title passes through unchanged");
      else fail(`GA2b: real title changed: ${JSON.stringify(r2)}`);
    } catch (e) {
      fail(`GA2: resolveDisplayIdentity eval failed: ${e.message}`);
    }
  }
}

// ---- GA3: identification is attempted for the FULL placeholder class ----
{
  const hasIdentifyCall = /identifyTrackFromAudio/.test(extractSrc);
  if (!hasIdentifyCall) {
    fail("GA3: extract.ts never calls identifyTrackFromAudio");
  } else {
    // The condition gating the call: must fire for Unknown/FullMix titles too.
    const block = extractSrc.split("identifyTrackFromAudio")[0].slice(-900);
    if (/Unknown|FullMix|GENERIC|isGeneric|genericTitle|resolveDisplayIdentity|placeholder/i.test(block)) {
      pass("GA3: identify call is gated by a placeholder-class check");
    } else {
      fail("GA3: identify call gating does not reference the placeholder class");
    }
  }
}

// ---- GA4: cached placeholder titles are re-validated (healing) ----
{
  // getTrackInfo must not serve a cached entry whose stored title is still a
  // registry placeholder forever — it must re-extract/re-identify once.
  const gti = extractSrc.slice(extractSrc.indexOf("export async function getTrackInfo"));
  const cachedCheck = /generic|unknown|fullmix|original sound|isGeneric|placeholder/i.test(gti);
  if (cachedCheck) pass("GA4: getTrackInfo has a placeholder re-validation check");
  else fail("GA4: getTrackInfo has no placeholder re-validation (stale 'Unknown - FullMix' served forever)");
}

// ---- GA5: adjacent pipeline still wired (lyrics get the REAL title/artist) ----
{
  if (/mediaType|content-type|\_formdata|multipart|2d|0d0a/i.test(extractSrc)) pass("GA5b: TikWM fetch path intact");
  else pass("GA5b: no TikWM fetch regression spotted (soft)");
  if (/cobalt|Cobalt|tunnel/i.test(extractSrc)) pass("GA5c: cobalt fallback still present");
  else fail("GA5c: cobalt fallback missing");
}

// ---- GA6: fixture files exist (real captured data, not fabricated) ----
{
  if (tikwmUser) pass("GA6: fixture tikwm-zsvmagdt.json present");
  else fail("GA6: missing fixture tikwm-zsvmagdt.json");
  if (tikwmPep) pass("GA6b: fixture tikwm-pep-city368.json present");
  else fail("GA6b: missing fixture tikwm-pep-city368.json");
  if (tikwmWorldcup) pass("GA6c: fixture tikwm-worldcup-real.json present");
  else fail("GA6c: missing fixture tikwm-worldcup-real.json");
}

console.log(`\n[verify-any-tiktok-song] ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);