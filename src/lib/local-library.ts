// Browser-only local library: IndexedDB-backed play history + in-memory snapshot.
// Never throws — all failures resolve to safe fallbacks.

import { shouldLogPlay } from "./library-core";

export interface LibraryRecord {
  id: string;
  title: string;
  artist: string;
  duration: number;
  playCount: number;
  lastPlayedAt: number;
  addedAt: number;
}

const DB_NAME = "vibemusic";
const DB_VERSION = 2;
const STORE_NAME = "library";

function getDb(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === "undefined") return null;
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio");
      if (!db.objectStoreNames.contains("lyrics")) db.createObjectStore("lyrics");
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// In-memory snapshot cache
let snapshotCache: LibraryRecord[] = [];
const snapshotMap = new Map<string, LibraryRecord>();

function updateCache(record: LibraryRecord) {
  snapshotMap.set(record.id, record);
  snapshotCache = Array.from(snapshotMap.values());
}

async function getAllRecords(): Promise<LibraryRecord[]> {
  const db = getDb();
  if (!db) return [];
  const database = await db;
  return new Promise<LibraryRecord[]>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function getRecord(id: string): Promise<LibraryRecord | null> {
  const db = getDb();
  if (!db) return null;
  const database = await db;
  return new Promise<LibraryRecord | null>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function putRecord(record: LibraryRecord): Promise<void> {
  const db = getDb();
  if (!db) return;
  const database = await db;
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function recordPlayStart(id: string, partial: { title?: string; artist?: string; duration?: number }): Promise<void> {
  try {
    if (typeof indexedDB === "undefined") return;
    const existing = await getRecord(id);
    const now = Date.now();
    const record: LibraryRecord = {
      id,
      title: partial.title || existing?.title || "",
      artist: partial.artist || existing?.artist || "",
      duration: partial.duration || existing?.duration || 0,
      playCount: (existing?.playCount || 0) + 1,
      lastPlayedAt: now,
      addedAt: existing?.addedAt || now,
    };
    await putRecord(record);
    updateCache(record);
  } catch {
    // swallow
  }
}

export async function markListened(id: string, seconds: number): Promise<void> {
  try {
    if (typeof indexedDB === "undefined") return;
    if (!shouldLogPlay(seconds)) return;
    const existing = await getRecord(id);
    const now = Date.now();
    const record: LibraryRecord = {
      id,
      title: existing?.title || "",
      artist: existing?.artist || "",
      duration: existing?.duration || 0,
      playCount: existing?.playCount || 0,
      lastPlayedAt: now,
      addedAt: existing?.addedAt || now,
    };
    await putRecord(record);
    updateCache(record);
  } catch {
    // swallow
  }
}

export async function getLibrarySnapshot(): Promise<LibraryRecord[]> {
  try {
    if (typeof indexedDB === "undefined") return [];
    const records = await getAllRecords();
    snapshotCache = records;
    snapshotMap.clear();
    for (const r of records) snapshotMap.set(r.id, r);
    return records;
  } catch {
    return [];
  }
}

export function getSnapshotSync(): LibraryRecord[] {
  return snapshotCache;
}
