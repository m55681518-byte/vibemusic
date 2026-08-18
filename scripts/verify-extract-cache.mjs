// Acceptance gate: server-side extraction cache hit path (journal 041 audit).
// getTrackInfo(url) must return { cached: true } with the stored track
// WITHOUT re-querying TikWM/Cobalt/Whisper when a valid non-placeholder
// meta.json + non-zero mp3 exist for the URL's id. Hermetic (temp dir, no
// network on the hit path). Mirrors tests/extract-cache.test.mjs.
// Exit 0 = accept, 1 = reject.
import { promises as fsp } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Resolve hook: project TS uses extensionless relative imports ("./store").
register("../tests/hooks.mjs", import.meta.url);

const tmp = mkdtempSync(path.join(os.tmpdir(), "vibemusic-extract-gate-"));
process.env.STORAGE_DIR = tmp;

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

const { getTrackInfo } = await import(pathToFileURL(path.join(root, "src/lib/extract.ts")).href);
const { idForUrl } = await import(pathToFileURL(path.join(root, "src/lib/store.ts")).href);

const URL = "https://www.tiktok.com/@audit/video/9876543210987654321";
const id = idForUrl(URL);

await fsp.writeFile(
  path.join(tmp, `${id}.json`),
  JSON.stringify({
    id,
    url: URL,
    title: "Real Song - Real Artist",
    artist: "Real Artist",
    mp3Path: path.join(tmp, `${id}.mp3`),
    sizeBytes: 4096,
    createdAt: Date.now(),
  }),
  "utf8",
);
await fsp.writeFile(path.join(tmp, `${id}.mp3`), Buffer.alloc(4096, 1));

try {
  const started = Date.now();
  const { track, cached } = await getTrackInfo(URL);
  const elapsed = Date.now() - started;
  if (cached === true) pass("E1: cached result returned without re-querying externals");
  else fail(`E1: expected cached:true, got ${cached}`);
  if (track.title === "Real Song - Real Artist" && track.id === id)
    pass("E2: stored track metadata served verbatim");
  else fail(`E2: metadata mismatch (title=${track.title}, id=${track.id})`);
  if (elapsed < 5000) pass(`E3: hit path is instant (${elapsed}ms)`);
  else fail(`E3: hit path too slow (${elapsed}ms) — network leak?`);

  const before = await fsp.stat(path.join(tmp, `${id}.mp3`));
  await getTrackInfo(URL);
  const after = await fsp.stat(path.join(tmp, `${id}.mp3`));
  if (before.mtimeMs === after.mtimeMs && before.size === after.size)
    pass("E4: cached files untouched by repeat hits");
  else fail("E4: cache hit modified stored files");
} catch (e) {
  fail("E: cache hit path threw: " + (e instanceof Error ? e.message : String(e)));
}

console.log(`\n[verify-extract-cache] ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);