"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { TrackMeta } from "@/lib/store";
import { parseLrc, sanitizeFilename, bytesToBase64 } from "@/lib/utils";
import { LyricsView } from "@/components/LyricsView";

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
  const [title, setTitle] = useState(meta.title);
  const [artist, setArtist] = useState(meta.artist);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [downloadHref, setDownloadHref] = useState<string | null>(null);
  const [synced, setSynced] = useState<{ time: number; text: string }[] | null>(null);
  const [plain, setPlain] = useState<string | null>(null);
  const [hasLyrics, setHasLyrics] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const audioRef = useRef<HTMLAudioElement>(null);
  const downloadRef = useRef<HTMLAnchorElement>(null);

  const resetTimers = useCallback(() => {
    setSynced(null);
    setPlain(null);
    setHasLyrics(false);
    setActiveIndex(-1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];

    const load = async () => {
      try {
        setStatus("loading-tags");
        resetTimers();

        const res = await fetch(`/api/audio/${meta.id}`);
        if (!res.ok) throw new Error(`Audio unavailable (${res.status})`);
        const blob = await res.blob();

        const audioUrl = URL.createObjectURL(blob);
        const downloadUrl = URL.createObjectURL(blob);
        objectUrls.push(audioUrl, downloadUrl);
        if (cancelled) return;

        setAudioUrl(audioUrl);
        setDownloadHref(downloadUrl);

        const tags = await parseId3(blob);
        if (tags.title) setTitle(tags.title);
        if (tags.artist) setArtist(tags.artist);
        if (tags.coverDataUrl) {
          setCoverDataUrl(tags.coverDataUrl);
          setFallbackThumb(null);
        }

        setStatus("fetching-lyrics");

        try {
          const lyricsRes = await fetch(
            `/api/lyrics?artist=${encodeURIComponent(tags.artist || meta.artist)}&title=${encodeURIComponent(
              tags.title || meta.title,
            )}`,
          );
          if (lyricsRes.ok) {
            const lyrics = (await lyricsRes.json()) as {
              synced?: string | null;
              plain?: string | null;
            };
            if (cancelled) return;
            if (lyrics.synced) {
              setSynced(parseLrc(lyrics.synced));
              setHasLyrics(true);
            } else if (lyrics.plain) {
              setPlain(lyrics.plain);
              setHasLyrics(true);
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
      objectUrls.forEach((u) => URL.revokeObjectURL(u));
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

  const handleDownload = useCallback(() => {
    if (!downloadRef.current) return;
    downloadRef.current.click();
  }, []);

  const coverSrc = coverDataUrl || fallbackThumb;
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
        </div>

        <div className="cp-meta">
          <h1 className="cp-title">{title}</h1>
          <p className="cp-artist">{artist}</p>
          {meta.extractor && <p className="muted small">via {meta.extractor}</p>}
        </div>

        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={audioUrl ?? undefined}
          className="cp-audio"
        />

        <div className="cp-actions">
          <a
            ref={downloadRef}
            href={downloadHref ?? undefined}
            download={fileName}
            aria-hidden={!downloadHref}
            tabIndex={-1}
            style={{ display: "none" }}
          >
            {fileName}
          </a>
          <button className="btn" onClick={handleDownload} disabled={!downloadHref}>
            Download .mp3
          </button>
          {meta.webpageUrl && (
            <a className="btn btn-ghost" href={meta.webpageUrl} target="_blank" rel="noreferrer">
              Open source
            </a>
          )}
        </div>

        {!(audioUrl && downloadHref) && (
          <p className="saving-hint">
            {status === "loading-tags" && "Parsing ID3 tags…"}
            {status === "fetching-lyrics" && "Finding lyrics…"}
            {status === "error" && `Error: ${error}`}
          </p>
        )}
      </section>

      <LyricsView synced={hasLyrics ? synced : null} plain={hasLyrics ? plain : null} activeIndex={activeIndex} />

      <p className="player-foot muted">
        <Link href="/">Extract another track</Link>
      </p>
    </main>
  );
}