"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export function MiniPlayer() {
  const [last, setLast] = useState<{ id: string; title: string; artist: string; thumb?: string; position?: number; volume?: number } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("vibemusic-last");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.id) setLast(parsed);
      }
    } catch {}
  }, []);

  if (!last) return null;

  return (
    <Link href={`/player/${last.id}`} className="mini-player" style={{
      position: "fixed",
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 50,
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 16px",
      background: "rgba(10,10,14,0.9)",
      backdropFilter: "blur(20px) saturate(180%)",
      borderTop: "1px solid rgba(255,255,255,0.08)",
      color: "#fff",
    }} aria-label="Continue listening">
      <div style={{ width: 48, height: 48, flexShrink: 0, borderRadius: 8, overflow: "hidden", background: "#222" }}>
        {last.thumb ? <img src={last.thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>♪</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{last.title}</div>
        <div style={{ fontSize: 12, opacity: 0.7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{last.artist}</div>
      </div>
      <div style={{ fontSize: 12, opacity: 0.6 }}>{last.position ? `${Math.round(last.position)}s` : "Resume"}</div>
    </Link>
  );
}
