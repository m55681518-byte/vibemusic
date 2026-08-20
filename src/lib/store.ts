import { promises as fsp } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export interface TrackMeta {
  id: string;
  url: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
  webpageUrl?: string;
  extractor?: string;
  mp3Path: string;
  sizeBytes: number;
  createdAt: number;
  /** True once the track's real song identity is confirmed (named sound or
   * audio-identified). Absent/undefined marks a legacy cached track that was
   * extracted before background-music/caption handling was fixed and must be
   * re-resolved. */
  identified?: boolean;
}

const VALID_ID = /^[a-z0-9_-]{1,64}$/i;

export function storageDir(): string {
  return process.env.STORAGE_DIR || path.join(process.cwd(), "storage");
}

export function isValidId(id: string): boolean {
  return VALID_ID.test(id);
}

export function idForUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

export function mp3PathFor(id: string): string {
  return path.join(storageDir(), `${id}.mp3`);
}

export function metaPathFor(id: string): string {
  return path.join(storageDir(), `${id}.json`);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function saveMeta(meta: TrackMeta): Promise<void> {
  await fsp.mkdir(storageDir(), { recursive: true });
  await fsp.writeFile(metaPathFor(meta.id), JSON.stringify(meta, null, 2), "utf8");
}

export async function loadMeta(id: string): Promise<TrackMeta | null> {
  if (!isValidId(id)) return null;
  try {
    const raw = await fsp.readFile(metaPathFor(id), "utf8");
    return JSON.parse(raw) as TrackMeta;
  } catch {
    return null;
  }
}

export async function pruneStorage(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  try {
    const dir = storageDir();
    const now = Date.now();
    for (const name of await fsp.readdir(dir)) {
      if (!name.endsWith(".mp3") && !name.endsWith(".json") && !name.endsWith(".srt")) continue;
      const full = path.join(dir, name);
      try {
        const stat = await fsp.stat(full);
        if (now - stat.mtimeMs > maxAgeMs) await fsp.unlink(full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}