"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

type Phase =
  | { kind: "idle" }
  | { kind: "working"; step: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

const STEPS = [
  "Contacting extractor…",
  "Fetching media metadata…",
  "Downloading audio stream…",
  "Converting to MP3…",
  "Embedding cover art + ID3 tags…",
];

interface ExtractResult {
  id: string;
  error?: string;
  cached?: boolean;
  title?: string;
}

async function runExtract(url: string): Promise<ExtractResult> {
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = (await res.json().catch(() => null)) as ExtractResult | null;
  if (!res.ok || !data || !data.id) {
    throw new Error(data?.error || `Server error (${res.status})`);
  }
  return data;
}

function ExtractFlow() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const url = searchParams.get("url") || "";

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    if (phase.kind !== "working") return;
    if (!url) return;
    const t = setTimeout(() => {
      setPhase((p) => {
        if (p.kind !== "working") return p;
        const next = STEPS.indexOf(p.step) + 1;
        return { ...p, step: STEPS[next % STEPS.length] };
      });
    }, 1800);
    return () => clearTimeout(t);
  }, [phase, url]);

  useEffect(() => {
    if (!url) {
      setPhase({ kind: "error", message: "No URL provided." });
      return;
    }
    let cancelled = false;
    setPhase({ kind: "working", step: STEPS[0] });

    (async () => {
      try {
        const data = await runExtract(url);
        if (cancelled) return;
        setPhase({ kind: "done" });
        router.replace(`/player/${data.id}`);
      } catch (err) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : "Extraction failed.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, router]);

  return (
    <section className="panel">
      {phase.kind === "idle" && (
        <p className="muted">
          <Link href="/">Go back</Link> and paste a link, or share one from an app on your phone.
        </p>
      )}

      {phase.kind === "working" && (
        <div className="working">
          <span className="spinner" aria-hidden="true" />
          <h2>Extracting audio</h2>
          <p className="muted">{phase.step}</p>
          <p className="muted small">
            Large videos can take a minute or two to download and convert.
          </p>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="error-box">
          <h2>Couldn’t extract that link</h2>
          <p>{phase.message}</p>
          <Link className="btn" href={`/extract?url=${encodeURIComponent(url || "https://")}`}>
            Try again
          </Link>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="working">
          <span className="spinner" aria-hidden="true" />
          <h2>Almost there…</h2>
          <p className="muted">Preparing your player.</p>
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