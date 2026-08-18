// Pure, framework-free track cache core with an injectable KV store.
// No imports — safe for node:test (type-stripping) and browser.

export type KVStore = {
  get(k: string): Promise<string | undefined>;
  set(k: string, v: string): Promise<void>;
  del?(k: string): Promise<void>;
};

export interface TrackCacheOptions {
  maxAudioBytes?: number;
}

export function audioCacheKey(id: string): string {
  return "vibemusic:audio:" + id;
}

export function lyricsCacheKey(id: string): string {
  return "vibemusic:lyrics:" + id;
}

export class TrackCacheCore {
  private store: KVStore;
  private maxAudioBytes: number;

  constructor(store: KVStore, opts?: TrackCacheOptions) {
    this.store = store;
    this.maxAudioBytes = opts?.maxAudioBytes ?? 64 * 1024 * 1024;
  }

  async getAudioBlob(id: string): Promise<Blob | null> {
    try {
      const raw = await this.store.get(audioCacheKey(id));
      if (!raw) return null;
      const { type, data } = JSON.parse(raw);
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type });
    } catch {
      return null;
    }
  }

  async setAudioBlob(id: string, blob: Blob, _opts?: TrackCacheOptions): Promise<void> {
    try {
      if (blob.size > this.maxAudioBytes) return;
      const buf = await blob.arrayBuffer();
      const arr = new Uint8Array(buf);
      let bin = "";
      for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
      const data = btoa(bin);
      await this.store.set(audioCacheKey(id), JSON.stringify({ type: blob.type, data }));
    } catch {
      /* swallow — cache failure must never break playback */
    }
  }

  async getLyrics(id: string): Promise<{ synced?: string | null; plain?: string | null; isInstrumental?: boolean } | null> {
    try {
      const raw = await this.store.get(lyricsCacheKey(id));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async setLyrics(
    id: string,
    payload: { synced?: string | null; plain?: string | null; isInstrumental?: boolean },
  ): Promise<void> {
    try {
      await this.store.set(lyricsCacheKey(id), JSON.stringify(payload));
    } catch {
      /* swallow */
    }
  }
}
