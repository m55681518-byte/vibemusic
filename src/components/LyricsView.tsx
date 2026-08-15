"use client";

import { useEffect, useRef } from "react";

interface LyricsViewProps {
  synced: { time: number; text: string }[] | null;
  plain: string | null;
  activeIndex: number;
}

export function LyricsView({ synced, plain, activeIndex }: LyricsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeRef.current || !scrollRef.current || activeIndex < 0) return;
    const container = scrollRef.current;
    const el = activeRef.current;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offset = elRect.top - containerRect.top - container.clientHeight / 2 + elRect.height / 2;
    container.scrollTo({ top: container.scrollTop + offset, behavior: "smooth" });
  }, [activeIndex]);

  if (!synced && !plain) {
    return (
      <section className="lyrics-empty">
        <p className="muted">No lyrics found for this track.</p>
      </section>
    );
  }

  if (synced) {
    return (
      <section className="lyrics" ref={scrollRef} aria-live="off">
        {synced.map((line, i) => (
          <div
            key={i}
            ref={i === activeIndex ? activeRef : undefined}
            className={i === activeIndex ? "lyric-line is-active" : "lyric-line"}
          >
            {line.text}
          </div>
        ))}
      </section>
    );
  }

  return (
    <section className="lyrics plain">
      <pre className="lyrics-plain">{plain}</pre>
    </section>
  );
}