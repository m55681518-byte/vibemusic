"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

type Phase =
  | { kind: "idle" }
  | { kind: "metadata"; meta: { id: string; title: string; artist: string; thumbnail?: string } }
  | { kind: "working"; meta: { id: string; title: string; artist: string; thumbnail?: string } }
  | { kind: "done"; id: string }
  | { kind: "error"; message: string; details?: string };

interface ExtractResult {
  id: string;
  error?: string;
  details?: string;
  cached?: boolean;
  title?: string;
}

class ExtractError extends Error {
  constructor(message: string, readonly details?: string) {
    super(message);
    this.name = "ExtractError";
  }
}

async function runMeta(url: string) {
  const res = await fetch("/api/extract-meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ url }),
  });
  return res.json();
}

async function runExtract(url: string): Promise<ExtractResult> {
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ url }),
  });
  const data = (await res.json().catch(() => null)) as ExtractResult | null;
  if (!res.ok || !data || !data.id) {
    throw new ExtractError(data?.error || `Server error (${res.status})`, data?.details);
  }
  return data;
}

function ExtractFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const url = searchParams.get("url") || "";

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (!url) {
      setPhase({ kind: "error", message: "No URL provided." });
      return;
    }
    let cancelled = false;

    (async () => {
      // STEP 1: Instant metadata (~100ms) — render player UI immediately
      try {
        const meta = await runMeta(url);
        if (cancelled) return;
        if (meta && meta.id) {
          setPhase({ kind: "metadata", meta });
          // STEP 2: Process audio in background — never block screen
          setPhase({ kind: "working", meta });
          const result = await runExtract(url);
          if (cancelled) return;
          setPhase({ kind: "done", id: result.id });
          router.replace(`/player/${result.id}`);
        }
      } catch (err) {
        if (cancelled) return;
        setPhase({ kind: "error", message: err instanceof Error ? err.message : "Extraction failed.", details: err instanceof ExtractError ? err.details : undefined });
      }
    })();

    return () => { cancelled = true; };
  }, [url, router]);

  return (
    <section className="panel">
      {phase.kind === "idle" && (
        <p className="muted">
          <Link href="/">Go back</Link> and paste a link, or share one from an app on your phone.
        </p>
      )}

      {(phase.kind === "metadata" || phase.kind === "working") && (
        <div className="instant-preview" style={{ animation: "fadeIn 0.3s ease" }}>
          <div className="preview-cover">
            {phase.meta.thumbnail ? (
              <img src={phase.meta.thumbnail} alt="" style={{ width: 160, height: 160, objectFit: "cover", borderRadius: 12, boxShadow: "0 10px 30px rgba(0,0,0,0.4)" }} />
            ) : (
              <div style={{ width: 160, height: 160, background: "linear-gradient(135deg, #2a2a2a, #1a1a1a)", borderRadius: 12 }} />
            )}
          </div>
          <h2 className="preview-title" style={{ marginTop: 16, fontSize: 20, fontWeight: 600 }}>{phase.meta.title}</h2>
          <p className="muted" style={{ marginBottom: 8 }}>{phase.meta.artist}</p>
          <p className="muted small" style={{ animation: "pulse 2s infinite" }}>
            Processing audio in background... <span aria-hidden="true">✨</span>
          </p>
          {/* Subtle glowing bottom toast — never a blocking modal */}
          <div className="glow-toast" style={{
            marginTop: 24,
            padding: "12px 20px",
            borderRadius: 9999,
            background: "rgba(255,255,255,0.05)",
            backdropFilter: "blur(12px)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 0 20px rgba(100,200,255,0.15)",
            fontSize: 14,
            color: "#ccc"
          }}>
            Audio stream initializing — playback starts in ~2s
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="error-box">
          <h2>Couldn’t extract that link</h2>
          <p>{phase.message}</p>
          {phase.details && (
            <details className="error-details" open>
              <summary>Raw error details</summary>
              <pre>{phase.details}</pre>
            </details>
          )}
          <Link className="btn" href={`/extract?url=${encodeURIComponent(url || "https://")}`}>
            Try again
          </Link>
        </div>
      )}
    </section>
  );
}

export default function ExtractPage() {
  return (
    <Suspense
      fallback={
        <section className="panel">
          <p className="muted">Loading…</p>
        </section>
      }
    >
      <ExtractFlow />
    </Suspense>
  );
}
