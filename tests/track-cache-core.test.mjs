// Failing acceptance test — defines the client track-cache core (journal 042:
// client persistence rebuild). Passes ONLY when src/lib/track-cache-core.ts
// exists and satisfies the contract below.
import { test } from "node:test";
import assert from "node:assert/strict";

let mod;
try {
  mod = await import("../src/lib/track-cache-core.ts");
} catch {
  throw new Error("src/lib/track-cache-core.ts missing — implement it (failing acceptance)");
}
const { TrackCacheCore, audioCacheKey, lyricsCacheKey } = mod;

async function memKV() {
  const m = new Map();
  return {
    get: async (k) => m.get(k),
    set: async (k, v) => { m.set(k, v); },
    del: async (k) => { m.delete(k); },
    peek: (k) => m.get(k),
  };
}

test("cache keys are namespaced per surface", () => {
  assert.equal(audioCacheKey("abc"), "vibemusic:audio:abc");
  assert.equal(lyricsCacheKey("abc"), "vibemusic:lyrics:abc");
  assert.notEqual(audioCacheKey("abc"), lyricsCacheKey("abc"));
});

test("audio blob round-trips through the injectable store", async () => {
  const kv = await memKV();
  const core = new TrackCacheCore(kv);
  const blob = new Blob(["ID3\x00\x01fake-mp3-bytes"], { type: "audio/mpeg" });
  await core.setAudioBlob("id1", blob);
  const out = await core.getAudioBlob("id1");
  assert.ok(out, "expected a blob back");
  assert.equal(out.type, "audio/mpeg");
  assert.equal(await out.text(), "ID3\x00\x01fake-mp3-bytes");
  assert.equal(await core.getAudioBlob("missing"), null);
});

test("oversized audio is refused silently (64MB default guard)", async () => {
  const kv = await memKV();
  const core = new TrackCacheCore(kv, { maxAudioBytes: 4 });
  const big = new Blob(["12345"], { type: "audio/mpeg" });
  await core.setAudioBlob("id2", big);
  assert.equal(await core.getAudioBlob("id2"), null);
  assert.equal(kv.peek(audioCacheKey("id2")), undefined, "large blob must not be stored");
});

test("storage failures are swallowed — cache never breaks playback", async () => {
  const boomKV = {
    get: async () => { throw new Error("store down"); },
    set: async () => { throw new Error("store down"); },
  };
  const core = new TrackCacheCore(boomKV);
  assert.equal(await core.getAudioBlob("x"), null);
  assert.equal(await core.getLyrics("x"), null);
  await core.setAudioBlob("x", new Blob(["y"])); // must not throw
  await core.setLyrics("x", { synced: "[00:01.00] hi" }); // must not throw
});

test("lyrics round-trip with all fields", async () => {
  const kv = await memKV();
  const core = new TrackCacheCore(kv);
  await core.setLyrics("id3", { synced: "[00:01.00] line", plain: "line", isInstrumental: false });
  const got = await core.getLyrics("id3");
  assert.deepEqual(got, { synced: "[00:01.00] line", plain: "line", isInstrumental: false });
  assert.equal(await core.getLyrics("missing"), null);
  await core.setLyrics("id4", { isInstrumental: true });
  assert.equal((await core.getLyrics("id4")).isInstrumental, true);
});

test("corrupt stored audio payload degrades to null, not throw", async () => {
  const kv = await memKV();
  await kv.set(audioCacheKey("corrupt"), "{not-json");
  const core = new TrackCacheCore(kv);
  assert.equal(await core.getAudioBlob("corrupt"), null);
});