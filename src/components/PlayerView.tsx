"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { TrackMeta } from "@/lib/store";
import { parseLrc, sanitizeFilename, bytesToBase64 } from "@/lib/utils";
import { LyricsView } from "@/components/LyricsView";
import { cachedAudioUrl, rememberAudio, cachedLyrics, rememberLyrics } from "@/lib/client-cache";
import { recordPlayStart, markListened } from "@/lib/local-library";
import { shouldLogPlay } from "@/lib/library-core";

type Status = "loading-tags" | "fetching-lyrics" | "ready" | "error";

interface ParsedTags {
  title?: string;
  artist?: string;
  coverDataUrl?: string;
}

async function parseId3(blob: Blob): Promise<ParsedTags> {
  try {
    const mod = await import("jsmediatags");
    const api = mod.default ?? mod;
    const result = await new Promise<ParsedTags>((resolve) => {
      api.read(blob as Blob, {
        onSuccess: (data: {
          tags: { title?: string; artist?: string; picture?: { format: string; data: Uint8Array }[] };
        }) => {
          const tags = data?.tags ?? {};
          const picture = Array.isArray(tags.picture) ? tags.picture[0] : undefined;
          let coverDataUrl: string | undefined;
          if (picture?.data) {
            const format = /^image\//.test(picture.format) ? picture.format : "image/jpeg";
            coverDataUrl = `data:${format};base64,${bytesToBase64(picture.data)}`;
          }
          resolve({
            title: tags.title,
            artist: tags.artist,
            coverDataUrl,
          });
        },
        onError: () => resolve({}),
      });
    });
    return result;
  } catch {
    return {};
  }
}

export function PlayerView({ meta }: { meta: TrackMeta }) {
  const [status, setStatus] = useState<Status>("loading-tags");
  const [error, setError] = useState("");
  const [coverDataUrl, setCoverDataUrl] = useState<string | null>(null);
  const [fallbackThumb, setFallbackThumb] = useState<string | null>(meta.thumbnail ?? null);
  const coverSrc = coverDataUrl || fallbackThumb;
  const [title, setTitle] = useState(meta.title);
  const [artist, setArtist] = useState(meta.artist);
  const [synced, setSynced] = useState<{ time: number; text: string }[] | null>(null);
  const [plain, setPlain] = useState<string | null>(null);
  const [hasLyrics, setHasLyrics] = useState(false);
  const [isInstrumental, setIsInstrumental] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [lyricsExpanded, setLyricsExpanded] = useState(false);
  const [shuffle, setShuffle] = useState(false);

  const [audioSrc, setAudioSrc] = useState<string>(`/api/audio/${meta.id}`);

  const audioRef = useRef<HTMLAudioElement>(null);
  const listenedRef = useRef(false);
  // MediaSession API — lock screen / notification shade integration
  useEffect(() => {
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || meta.title,
        artist: artist || meta.artist,
        album: meta.album || "VibeMusic",
        artwork: coverSrc ? [{ src: coverSrc, sizes: "512x512", type: "image/jpeg" }] : [],
      });
      navigator.mediaSession.setActionHandler("play", () => audioRef.current?.play());
      navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
      navigator.mediaSession.setActionHandler("previoustrack", () => { /* skip prev */ });
      navigator.mediaSession.setActionHandler("nexttrack", () => { /* skip next */ });
    }
  }, [title, artist, meta, coverSrc]);


  // Reset listened flag when track changes
  useEffect(() => {
    listenedRef.current = false;
  }, [meta.id]);

  const resetTimers = useCallback(() => {
    setSynced(null);
    setPlain(null);
    setHasLyrics(false);
    setIsInstrumental(false);
    setActiveIndex(-1);
  }, []);

  // Record play start on audio play
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handlePlay = () => {
      recordPlayStart(meta.id, {
        title: title || meta.title,
        artist: artist || meta.artist,
        duration: meta.duration,
      }).catch(() => {});
    };
    audio.addEventListener("play", handlePlay);
    return () => audio.removeEventListener("play", handlePlay);
  }, [meta.id, meta.title, meta.artist, meta.duration, title, artist]);

  // Mark listened once per track when >=10s
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleTimeUpdate = () => {
      if (!listenedRef.current && shouldLogPlay(audio.currentTime)) {
        listenedRef.current = true;
        markListened(meta.id, audio.currentTime).catch(() => {});
      }
    };
    audio.addEventListener("timeupdate", handleTimeUpdate);
    return () => audio.removeEventListener("timeupdate", handleTimeUpdate);
  }, [meta.id]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        setStatus("loading-tags");
        resetTimers();

        // Playback and download stream straight from the audio endpoint
        // (it supports Range/206), so they start immediately — never gated on
        // fetching the whole file into a blob.
        const audioUrl = `/api/audio/${meta.id}`;

        // Check local IndexedDB cache first (survives server spin-down).
        let blobUrl: string | null = null;
        try {
          blobUrl = await cachedAudioUrl(meta.id);
        } catch {
          /* IndexedDB unavailable or corrupt — proceed to network */
        }

        if (!cancelled) {
          if (blobUrl) setAudioSrc(blobUrl);
        }

        // Fetch metadata (ID3 tags / embedded cover art) in the background to
        // enrich title/artist/cover. Neither playback nor download waits on it.
        let blob: Blob | null = null;
        try {
          const res = await fetch(blobUrl || audioUrl);
          if (!res.ok) throw new Error(`Audio unavailable (${res.status})`);
          blob = await res.blob();
        } catch {
          // If we already have a cached blob URL, playback can still proceed.
          if (blobUrl) {
            if (!cancelled) setStatus("fetching-lyrics");
          } else {
            throw new Error(`Audio unavailable`);
          }
        }

        if (cancelled) return;

        let tags: ParsedTags = {};
        if (blob) {
          tags = await parseId3(blob);
          if (tags.title) setTitle(tags.title);
          if (tags.artist) setArtist(tags.artist);
          if (tags.coverDataUrl) {
            setCoverDataUrl(tags.coverDataUrl);
            setFallbackThumb(null);
          }
          // Store fetched blob in IndexedDB for offline playback.
          if (!blobUrl) rememberAudio(meta.id, blob).catch(() => {});
        }

        setStatus("fetching-lyrics");

        try {
          const cached = await cachedLyrics(meta.id);
          if (cancelled) return;
          if (cached) {
            if (cached.isInstrumental) {
              setIsInstrumental(true);
            } else if (cached.synced) {
              setSynced(parseLrc(cached.synced));
              setHasLyrics(true);
            } else if (cached.plain) {
              setPlain(cached.plain);
              setHasLyrics(true);
            }
          } else {
            const lyricsRes = await fetch(
              `/api/lyrics?artist=${encodeURIComponent(tags?.artist || meta.artist)}&title=${encodeURIComponent(
                tags?.title || meta.title,
              )}&id=${encodeURIComponent(meta.id)}`,
            );
            if (lyricsRes.ok) {
              const lyrics = (await lyricsRes.json()) as {
                synced?: string | null;
                plain?: string | null;
                isInstrumental?: boolean;
              };
              if (cancelled) return;
              rememberLyrics(meta.id, { synced: lyrics.synced, plain: lyrics.plain, isInstrumental: lyrics.isInstrumental }).catch(() => {});
              if (lyrics.isInstrumental) {
                setIsInstrumental(true);
              } else if (lyrics.synced) {
                setSynced(parseLrc(lyrics.synced));
                setHasLyrics(true);
              } else if (lyrics.plain) {
                setPlain(lyrics.plain);
                setHasLyrics(true);
              }
            }
          }
        } catch {
          /* lyrics are optional */
        }

        if (!cancelled) setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Something went wrong loading the track.");
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [meta.id, meta.artist, meta.title, resetTimers]);

  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (audio && synced?.length) {
      let idx = -1;
      for (let i = 0; i < synced.length; i++) {
        if (synced[i].time <= audio.currentTime) idx = i;
        else break;
      }
      setActiveIndex(idx);
    }
  }, [synced]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => onTimeUpdate();
    audio.addEventListener("timeupdate", onTime);
    return () => audio.removeEventListener("timeupdate", onTime);
  }, [onTimeUpdate]);
  // App State Memory — persist last listened track, position, volume
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const save = () => {
      try {
        localStorage.setItem("vibemusic-last", JSON.stringify({
          id: meta.id,
          title: title || meta.title,
          artist: artist || meta.artist,
          thumb: coverSrc || meta.thumbnail,
          position: audio.currentTime,
          volume: audio.volume,
          time: Date.now(),
        }));
      } catch {}
    };
    audio.addEventListener("pause", save);
    audio.addEventListener("timeupdate", save);
    return () => { audio.removeEventListener("pause", save); audio.removeEventListener("timeupdate", save); };
  }, [meta.id, title, artist, coverSrc]);


  const fileName = `${sanitizeFilename(title)}.mp3`;

  return (
    <main className="player">
      <section className="cp-card">
        <div className="cover-wrap">
          {coverSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="cover"
              src={coverSrc}
              alt={`${title} — ${artist}`}
              width={320}
              height={320}
            />
          ) : (
            <div className="cover cover-fallback" aria-hidden="true">
              <span>♪</span>
            </div>
          )}
          {isInstrumental && (
            <div className="cover-overlay" aria-hidden="true">
              <div className="eq-bars">
                <span className="eq-bar" />
                <span className="eq-bar" />
                <span className="eq-bar" />
                <span className="eq-bar" />
                <span className="eq-bar" />
                <span className="eq-bar" />
                <span className="eq-bar" />
              </div>
              <span className="instrumental-badge">Instrumental / Beats Only</span>
            </div>
          )}
        </div>

<button onClick={async () => { const q = (title || meta.title) + " " + (artist || meta.artist); const res = await fetch(`/api/itunes?query=${encodeURIComponent(q)}`); if (res.ok) { const data = await res.json(); if (data.url) { setCoverDataUrl(data.url); setFallbackThumb(null); } } }} style={{ marginTop: 8, padding: "8px 14px", borderRadius: 99, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.05)", color: "#fff", cursor: "pointer" }}>+ Get cover</button>
        <div className="cp-meta">
          <h1 className="cp-title">{title}</h1>
          <p className="cp-artist">{artist}</p><button onClick={() => { try { const key = "vibemusic-liked-" + meta.id; const cur = localStorage.getItem(key); localStorage.setItem(key, cur ? "" : "1"); } catch {} }} style={{ marginLeft: 8, background: "none", border: "none", fontSize: 22, cursor: "pointer" }} aria-label="Like">♥</button>
          {meta.extractor && <p className="muted small">via {meta.extractor}</p>}
        </div>

        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={audioSrc}
          className="cp-audio"
        />


        {/* Playback Controls: Shuffle, Loop, Speed */}
        <div className="cp-controls" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, margin: "8px 0" }}>
          <button onClick={() => setShuffle((s) => !s)} aria-label="Shuffle" title="Shuffle" style={{ background: shuffle ? "rgba(120,180,255,0.25)" : "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", borderRadius: 99, padding: "8px 14px", cursor: "pointer", fontSize: 13 }}>🔀 Shuffle</button>
          <button onClick={() => { const a = audioRef.current; if (a) a.loop = !a.loop; }} aria-label="Loop" title="Loop" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", borderRadius: 99, padding: "8px 14px", cursor: "pointer", fontSize: 13 }}>♻ Loop</button>
          <button onClick={() => { const a = audioRef.current; if (a) { const s = [0.75,1,1.25,1.5]; const i = s.indexOf(a.playbackRate||1); a.playbackRate = s[(i+1)%s.length]; } }} aria-label="Playback speed" title="Playback speed" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", borderRadius: 99, padding: "8px 14px", cursor: "pointer", fontSize: 13 }}>⏱ Speed</button>
          <button onClick={() => { const a = audioRef.current; if (a) { const mins = [10, 20, 30, 60]; const choice = prompt("Sleep timer (minutes): 10 / 20 / 30 / 60"); if (choice) { const m = parseInt(choice); if ([10,20,30,60].includes(m)) setTimeout(() => a.pause(), m * 60000); } } }} aria-label="Sleep timer" title="Sleep timer" style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", borderRadius: 99, padding: "8px 14px", cursor: "pointer", fontSize: 13 }}>⏲ Sleep</button>

        </div>

        {/* Glassmorphic Peek — Always-On Mini Lyric Line */}
        {synced && synced.length > 0 && (
          <div style={{ position: "relative", marginTop: 8, padding: "10px 16px", borderRadius: 16, background: "rgba(255,255,255,0.05)", backdropFilter: "blur(16px) saturate(120%)", border: "1px solid rgba(255,255,255,0.1)", overflow: "hidden", cursor: "pointer" }}>
            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 15, color: "#eee" }}>
              {synced[activeIndex >= 0 ? activeIndex : 0]?.text || "..."}
            </div>
          </div>
        )}
        {lyricsExpanded && (
          <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10, padding: "24px 16px 16px", background: "linear-gradient(to top, rgba(10,10,16,0.92), rgba(10,10,16,0.6))", backdropFilter: "blur(20px)", borderTop: "1px solid rgba(255,255,255,0.1)", maxHeight: "50vh", overflowY: "auto", maskImage: "linear-gradient(to bottom, black 70%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, black 70%, transparent 100%)" }}>
            <h3 style={{ fontSize: 16, marginBottom: 8, opacity: 0.8 }}>Lyrics</h3>
            <LyricsView synced={hasLyrics ? synced : null} plain={hasLyrics ? plain : null} activeIndex={activeIndex} />
          </div>
        )}

        <div className="cp-actions">
          <a className="btn" href={`/api/audio/${meta.id}?download=1`} download={fileName}>
            Download .mp3
          </a>
          {meta.webpageUrl && (
            <a className="btn btn-ghost" href={meta.webpageUrl} target="_blank" rel="noreferrer">
              Open source
            </a>
          )}
        </div>

        {status !== "ready" && (
          <p className="saving-hint">
            {status === "loading-tags" && "Warming up…"}
            {status === "fetching-lyrics" && "Tuning the sound…"}
            {status === "error" && `Error: ${error}`}
          </p>
        )}
      </section>

      {isInstrumental ? (
        // Instrumental tracks have no lyrics section — the visualizer + badge
        // over the cover art communicates the beats-only state instead.
        <section className="lyrics-empty" aria-label="Instrumental track">
          <p className="muted">No vocals — instrumental beat only.</p>
        </section>
      ) : (
        <LyricsView synced={hasLyrics ? synced : null} plain={hasLyrics ? plain : null} activeIndex={activeIndex} />
      )}

      <p className="player-foot muted">
        <Link href="/">Extract another track</Link>
      </p>
    </main>
  );
}