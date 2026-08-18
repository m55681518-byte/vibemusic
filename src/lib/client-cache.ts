// Browser adapter: IndexedDB-backed track cache (audio blobs + lyrics).
// Wraps TrackCacheCore with a promise-wrapped IndexedDB store.
// Every exported function is guarded — never throws in the browser.

import { TrackCacheCore, type KVStore } from "./track-cache-core";

const DB_NAME = "vibemusic";

function idbStore(name: string): KVStore | null {
  if (typeof indexedDB === "undefined") return null;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function getDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio");
          if (!db.objectStoreNames.contains("lyrics")) db.createObjectStore("lyrics");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  return {
    async get(k: string) {
      const db = await getDb();
      return new Promise<string | undefined>((resolve, reject) => {
        const tx = db.transaction(name, "readonly");
        const req = tx.objectStore(name).get(k);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async set(k: string, v: string) {
      const db = await getDb();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, "readwrite");
        tx.objectStore(name).put(v, k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async del(k: string) {
      const db = await getDb();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(name, "readwrite");
        tx.objectStore(name).delete(k);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

const audioStore = idbStore("audio");
const lyricsStore = idbStore("lyrics");
const audioCore = audioStore ? new TrackCacheCore(audioStore) : null;
const lyricsCore = lyricsStore ? new TrackCacheCore(lyricsStore) : null;
export const clientCache = audioCore || lyricsCore
  ? { audio: audioCore, lyrics: lyricsCore }
  : null;

// --- Object-URL bookkeeping for audio blobs ---
const audioUrls = new Map<string, string>();

export async function cachedAudioUrl(id: string): Promise<string | null> {
  try {
    if (!audioCore) return null;
    const blob = await audioCore.getAudioBlob(id);
    if (!blob) return null;
    const prev = audioUrls.get(id);
    if (prev) URL.revokeObjectURL(prev);
    const url = URL.createObjectURL(blob);
    audioUrls.set(id, url);
    return url;
  } catch {
    return null;
  }
}

export async function rememberAudio(id: string, blob: Blob): Promise<void> {
  try {
    if (!audioCore) return;
    await audioCore.setAudioBlob(id, blob);
  } catch {
    /* swallow */
  }
}

export async function cachedLyrics(
  id: string,
): Promise<{ synced?: string | null; plain?: string | null; isInstrumental?: boolean } | null> {
  try {
    if (!lyricsCore) return null;
    return await lyricsCore.getLyrics(id);
  } catch {
    return null;
  }
}

export async function rememberLyrics(
  id: string,
  payload: { synced?: string | null; plain?: string | null; isInstrumental?: boolean },
): Promise<void> {
  try {
    if (!lyricsCore) return;
    await lyricsCore.setLyrics(id, payload);
  } catch {
    /* swallow */
  }
}
