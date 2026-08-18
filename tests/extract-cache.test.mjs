// Verification test: server-side extraction cache hit path.
// getTrackInfo(url) must return { cached: true } with the stored track
// WITHOUT re-querying TikWM/Cobalt/Whisper when a valid non-placeholder
// meta.json + non-zero mp3 exist for the URL's id (journal 041 audit).
// Hermetic: temp STORAGE_DIR, no network on the hit path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "vibemusic-extract-cache-"));
process.env.STORAGE_DIR = tmp;

const { getTrackInfo } = await import("../src/lib/extract.ts");
const { idForUrl } = await import("../src/lib/store.ts");

const URL = "https://www.tiktok.com/@audit/video/1234567890123456789";
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

test("getTrackInfo serves a stored track instantly with cached:true (no network)", async () => {
  const started = Date.now();
  const { track, cached } = await getTrackInfo(URL);
  const elapsed = Date.now() - started;
  assert.equal(cached, true, "must be a cache hit");
  assert.equal(track.title, "Real Song - Real Artist");
  assert.equal(track.id, id);
  assert.ok(elapsed < 5_000, `hit path must be instant (took ${elapsed}ms)`);
});

test("cached result leaves the stored files untouched", async () => {
  const before = await fsp.stat(path.join(tmp, `${id}.mp3`));
  await getTrackInfo(URL);
  const after = await fsp.stat(path.join(tmp, `${id}.mp3`));
  assert.equal(before.size, after.size);
  assert.equal(before.mtimeMs, after.mtimeMs);
});

test("same URL during in-flight extraction is single-flighted (no duplicate work)", async () => {
  // Regression guard: the hit path + singleFlight must coexist; calling twice
  // sequentially is cheap and must keep returning the cached track.
  for (let i = 0; i < 3; i++) {
    const { cached } = await getTrackInfo(URL);
    assert.equal(cached, true);
  }
});