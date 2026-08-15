"use client";

import { useCallback, useEffect, useRef } from "react";

interface LyricsViewProps {
  synced: { time: number; text: string }[] | null;
  plain: string | null;
  activeIndex: number;
}

// How long to wait after the user scrolls before auto-scroll takes over again.
const AUTO_SCROLL_RESUME_MS = 3000;
// How long a programmatic smooth scroll may keep firing scroll events before
// the next one counts as a user interaction.
const PROGRAMMATIC_SCROLL_MS = 800;

export function LyricsView({ synced, plain, activeIndex }: LyricsViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const isUserScrollingRef = useRef(false);
  const programmaticRef = useRef(false);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResumeTimer = useCallback(() => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }, []);

  const scrollActiveIntoView = useCallback(() => {
    const el = activeRef.current;
    if (!el) return;
    programmaticRef.current = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    clearResumeTimer();
    resumeTimerRef.current = setTimeout(() => {
      programmaticRef.current = false;
    }, PROGRAMMATIC_SCROLL_MS);
  }, [clearResumeTimer]);

  const pauseAutoScroll = useCallback(() => {
    isUserScrollingRef.current = true;
    clearResumeTimer();
    // After a quiet period, hand control back to the karaoke auto-scroll.
    resumeTimerRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
      scrollActiveIntoView();
    }, AUTO_SCROLL_RESUME_MS);
  }, [clearResumeTimer, scrollActiveIntoView]);

  const onScroll = useCallback(() => {
    // Ignore the scroll events our own smooth scrolling emits.
    if (programmaticRef.current) return;
    pauseAutoScroll();
  }, [pauseAutoScroll]);

  // Follow the active line while the user isn't scrubbing manually.
  useEffect(() => {
    if (activeIndex < 0 || isUserScrollingRef.current) return;
    scrollActiveIntoView();
  }, [activeIndex, scrollActiveIntoView]);

  // Clear any pending resume timer on unmount.
  useEffect(() => clearResumeTimer, [clearResumeTimer]);

  if (!synced && !plain) {
    return (
      <section className="lyrics-empty">
        <p className="muted">No lyrics found for this track.</p>
      </section>
    );
  }

  if (synced) {
    return (
      <section className="lyrics" ref={scrollRef} onScroll={onScroll} aria-live="off">
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
