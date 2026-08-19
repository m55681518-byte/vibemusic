"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSnapshotSync, getLibrarySnapshot, type LibraryRecord } from "@/lib/local-library";
import { computeLibraryRows, filterByMood } from "@/lib/library-core";
import { ExtractForm } from "@/components/ExtractForm";
import { InstallPwa } from "@/components/InstallPwa";
import { ShareTargetHint } from "@/components/ShareTargetHint";

const MOODS = ["Work out", "Relax", "Focus"] as const;
type MoodLabel = (typeof MOODS)[number];
const MOOD_KEY: Record<MoodLabel, string> = {
  "Work out": "work out",
  Relax: "relax",
  Focus: "focus",
};

function TrackCard({ track }: { track: LibraryRecord }) {
  return (
    <Link href={`/player/${track.id}`} className="row-item">
      <div className="row-item-inner">
        <div className="row-item-thumb" />
        <span className="row-item-title">{track.title}</span>
        <span className="row-item-artist">{track.artist}</span>
      </div>
    </Link>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="home-section">
      <h2 className="home-section-title">{title}</h2>
      {children}
    </section>
  );
}

export function HomeFeed() {
  // Snapshot read MUST appear before any fetch (local-first <10ms)
  const snapshot = getSnapshotSync();
  const [library, setLibrary] = useState<LibraryRecord[]>(snapshot);
  const [activeMood, setActiveMood] = useState<string | null>(null);

  // Hydrate from IDB on mount
  useEffect(() => {
    getLibrarySnapshot().then((records) => {
      if (records.length > 0) setLibrary(records);
    });
  }, []);

  const isEmpty = library.length === 0;

  if (isEmpty) {
    return (
      <>
        <section className="hero">
          <h1 className="hero-title">
            Extract the music.
            <br />
            <em>Keep the file.</em>
          </h1>
          <p className="hero-sub">
            Paste any link from TikTok, YouTube, Instagram, SoundCloud or hundreds of other
            platforms. VibeMusic pulls the audio, tags it with the cover art, and streams it with
            synced lyrics.
          </p>
          <InstallPwa />
        </section>
        <ExtractForm />
        <section className="cards" id="how">
          <div className="card">
            <span className="card-step">1</span>
            <h3>Share</h3>
            <p>
              On Android, share a video from any app — VibeMusic appears in your share sheet and
              opens right here.
            </p>
          </div>
          <div className="card">
            <span className="card-step">2</span>
            <h3>Extract</h3>
            <p>
              The backend pulls an audio-only stream and embeds the thumbnail as cover art.
            </p>
          </div>
          <div className="card">
            <span className="card-step">3</span>
            <h3>Play &amp; download</h3>
            <p>
              Scrolling synced lyrics, and the .mp3 saves straight to your Downloads folder.
            </p>
          </div>
        </section>
        <ShareTargetHint />
      </>
    );
  }

  const rows = computeLibraryRows(library, 42, Date.now());
  const filteredTracks = activeMood ? filterByMood(library, activeMood) : [];

  return (
    <div style={{ contentVisibility: 'auto' }}>
    <>
      {/* Speed Dial — 3x2 grid */}
      <Section title="Speed Dial">
        <div className="speed-dial-grid">
          {rows.speedDial.map((track: LibraryRecord) => (
            <Link key={track.id} href={`/player/${track.id}`} className="speed-dial-item">
              <div className="speed-dial-thumb" />
              <span className="speed-dial-title">{track.title}</span>
              <span className="speed-dial-artist">{track.artist}</span>
            </Link>
          ))}
        </div>
      </Section>

      {/* Mood chips */}
      <Section title="Mood">
        <div className="mood-chips">
          {MOODS.map((label) => (
            <button
              key={label}
              className={`mood-chip${activeMood === MOOD_KEY[label] ? " active" : ""}`}
              onClick={() => setActiveMood(activeMood === MOOD_KEY[label] ? null : MOOD_KEY[label])}
            >
              {label}
            </button>
          ))}
        </div>
        {activeMood && (
          <div className="row-scroller">
            {filteredTracks.map((track: LibraryRecord) => (
              <TrackCard key={track.id} track={track} />
            ))}
            {filteredTracks.length === 0 && <p className="muted">No tracks match this mood.</p>}
          </div>
        )}
      </Section>

      {/* Quick Picks */}
      <Section title="Quick Picks">
        <div className="row-scroller">
          {rows.quickPicks.map((track: LibraryRecord) => (
            <TrackCard key={track.id} track={track} />
          ))}
        </div>
      </Section>

      {/* Forgotten Favorites */}
      {rows.forgottenFavorites.length > 0 && (
        <Section title="Forgotten Favorites">
          <div className="row-scroller">
            {rows.forgottenFavorites.map((track: LibraryRecord) => (
              <TrackCard key={track.id} track={track} />
            ))}
          </div>
        </Section>
      )}

      {/* Long Listens */}
      {rows.longListens.length > 0 && (
        <Section title="Long Listens">
          <div className="row-scroller">
            {rows.longListens.map((track: LibraryRecord) => (
              <TrackCard key={track.id} track={track} />
            ))}
          </div>
        </Section>
      )}

      {/* Recently Played */}
      {rows.recent.length > 0 && (
        <Section title="Recently Played">
          <div className="row-scroller">
            {rows.recent.map((track: LibraryRecord) => (
              <TrackCard key={track.id} track={track} />
            ))}
          </div>
        </Section>
      )}
    </>
    </div>
  );
}
