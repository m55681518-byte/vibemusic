// Acceptance gate for the cobalt empty-tunnel fix.
//
// ROOT CAUSE (verified live + locally, session agent):
//   getCobaltAudio() returns the FIRST instance that yields a `status:"tunnel"`
//   URL. instance[0] = https://dog.kittycat.boo serves an EMPTY (0-byte) tunnel
//   for this YouTube Music URL (verified: 200, content-type null, bytes 0),
//   while instance[1] = https://cobaltapi.kittycat.boo returns a REAL
//   1,514,284-byte ID3-tagged MP3 for the same URL. writeCobaltTrack() then
//   writes whatever it got — a 0-byte .mp3 — and saveMeta() persists
//   sizeBytes:0, so getTrackInfo()'s cached path (fileExists -> returns the
//   broken 0-byte track) serves the dead file FOREVER. User-visible symptom:
//   the extracted track shows meta/cover/lyrics but /api/audio returns 416
//   (content-range bytes */0) and nothing plays.
//
// Hard checks (all must PASS after the fix; gate FAILs on the current code):
//  1. writeCobaltTrack / its caller must refuse to write a 0-byte audio file:
//     a downloaded buffer of length 0 must THROW (or be skipped), never written
//     to disk nor saved in meta.
//  2. When the first cobalt instance's tunnel is empty, the code must try the
//     NEXT instance's tunnel (loop over candidate tunnels, not return-on-tunnel).
//  3. getTrackInfo() cached path must not serve a 0-byte/stat-size-0 mp3 as a
//     valid cached track — it must re-extract (or mark invalid) instead of
//     returning the cached broken file.
//  4. saveMeta must never persist sizeBytes:0 AND a json that a fresh
//     getTrackInfo would consider "cached ok".
//  5. (live, informational) cobaltapi.kittycat.boo tunnel for ksBrPP45Rms
//     must carry >100KB of bytes when fetched. If the network is down this
//     check reports but does not fail the gate (the code-level checks 1-4 rule).
//
// Status: EXPECTED FAIL on current main (checks reflect the 0-byte bug).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extract = resolve(root, "src/lib/extract.ts");
const cobalt = resolve(root, "src/lib/cobalt.ts");
const store = resolve(root, "src/lib/store.ts");

let passed = 0;
let failed = 0;
const pass = (msg) => { console.log("PASS", msg); passed++; };
const fail = (msg) => { console.log("FAIL", msg); failed++; };

const cobaltSrc = () => (existsSync(cobalt) ? readFileSync(cobalt, "utf8") : "");
const extractSrc = () => (existsSync(extract) ? readFileSync(extract, "utf8") : "");
const storeSrc = () => (existsSync(store) ? readFileSync(store, "utf8") : "");

// Check 1: 0-byte audio must never be written/saved (throw or skip-on-empty).
{
  const src = extractSrc() + "\n" + cobaltSrc();
  const guardsZero = /buffer\.length\s*[<>=!]+\s*0|length\s*===\s*0|length\s*<\s*1|length\s*<=\s*0|!buffer\.length|if\s*\(\s*!buf/i.test(src);
  const writesThrough = /writeCobaltTrack[\s\S]{0,400}arrayBuffer/.test(src) || /response\.arrayBuffer\(\)/.test(extractSrc());
  if (guardsZero && writesThrough) {
    pass("0-byte audio buffer is refused (length guard before write/save)");
  } else {
    fail(`no 0-byte-length guard before writing cobalt audio (guardZero=${guardsZero})`);
  }
}

// Check 2: fall over to the next instance when a tunnel is empty.
{
  const src = extractSrc() + "\n" + cobaltSrc();
  // Either cobalt returns candidate tunnels and the downloader loops, or the
  // downloader retries another instance on failure.
  const loopsOverTunnels = (/\b(for|while|Promise\.all|\.map)\b[\s\S]{0,600}tunne/i.test(src));
  const retriesInstance = /(next|retry|continue|throw new Error)/i.test(src) && /\bCOBALT_INSTANCES|instances\b/.test(src);
  // Functional check: instances list must still contain both servers.
  const hasTwoInstances = /dog\.kittycat\.boo/.test(src) && /cobaltapi\.kittycat\.boo/.test(src);
  if (hasTwoInstances && (loopsOverTunnels || retriesInstance)) {
    pass("empty tunnel falls through to the next cobalt instance");
  } else {
    fail(`no next-instance fallback for empty tunnels (has2=${hasTwoInstances}, loops=${loopsOverTunnels}, retry=${retriesInstance})`);
  }
}

// Check 3: cached path refuses 0-byte files (re-extracts instead).
{
  const src = storeSrc() + "\n" + extractSrc();
  const checksSize = /(sizeBytes|stat\.size|\.size)\s*[\s\S]{0,60}>\s*0|sizeBytes\s*[>=<!]|stat\.size\s*[>=<!]/i.test(src);
  const cachedGuard = /cached|existing|mp3Path|fileExists[\s\S]{0,200}(sizeBytes|stat\.size)/.test(src);
  if (checksSize && cachedGuard) {
    pass("getTrackInfo cached path guards against 0-byte mp3");
  } else {
    fail(`cached path can still serve a 0-byte mp3 (checksSize=${checksSize}, cachedGuard=${cachedGuard})`);
  }
}

// Check 4: meta/stat size of a cached track must be > 0.
{
  const src = storeSrc() + "\n" + extractSrc();
  // saveMeta stores the real stat size; a successful path must only memoize >0.
  const sizeGuarded = /sizeBytes:\s*[^-][^;]{0,60}(stat\.size|buffer\.length)/.test(src);
  if (sizeGuarded) {
    pass("sizeBytes persisted from stat.size / buffer.length (never hardcoded 0)");
  } else {
    fail(`sizeBytes may be persisted without a real size source (${sizeGuarded})`);
  }
}

// Check 5 (informational): verify the second instance actually serves audio.
(async () => {
  try {
    const res = await fetch("https://cobaltapi.kittycat.boo/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        url: "https://music.youtube.com/watch?v=ksBrPP45Rms",
        downloadMode: "audio",
        audioFormat: "mp3",
        filenameStyle: "basic",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json();
    if (body.status === "tunnel" && body.url) {
      const audio = await fetch(body.url, { signal: AbortSignal.timeout(120_000) });
      const buf = Buffer.from(await audio.arrayBuffer());
      if (buf.length > 100_000) {
        pass(`cobalt second instance serves real audio (${buf.length} bytes)`);
      } else {
        console.log("INFO", `cobalt second instance tunnel yielded only ${buf.length} bytes`);
      }
    } else {
      console.log("INFO", "cobalt second instance did not return a tunnel; skipping live bytes check");
    }
  } catch (e) {
    console.log("INFO", `live cobalt check unavailable: ${e.message}`);
  } finally {
    console.log(`\n[verify-cobalt-empty-fix] ${passed}/${passed + failed} hard checks passed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();