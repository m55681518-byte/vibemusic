"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

export function ExtractForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const url = value.trim();
      if (!url) {
        setError("Paste a link first.");
        return;
      }
      try {
        new URL(url);
      } catch {
        setError("That doesn’t look like a valid URL (needs https://…).");
        return;
      }
      setError("");
      router.push(`/extract?url=${encodeURIComponent(url)}`);
    },
    [value, router],
  );

  return (
    <section className="extract">
      <form className="extract-form" onSubmit={submit}>
        <label htmlFor="vibe-url">Paste a video or audio link</label>
        <div className="extract-row">
          <input
            id="vibe-url"
            type="url"
            inputMode="url"
            placeholder="https://www.tiktok.com/@user/video/…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="url"
            required
          />
          <button type="submit" className="btn">
            Extract
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted small">
          Works on shared links from Android — VibeMusic also appears in your share sheet.
        </p>
      </form>
    </section>
  );
}