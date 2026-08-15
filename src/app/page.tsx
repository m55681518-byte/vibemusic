import { ExtractForm } from "@/components/ExtractForm";
import { InstallPwa } from "@/components/InstallPwa";
import { ShareTargetHint } from "@/components/ShareTargetHint";

export default function Home() {
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
            The backend pulls an audio-only MP3 stream and embeds the thumbnail as cover art via
            ID3 tags.
          </p>
        </div>
        <div className="card">
          <span className="card-step">3</span>
          <h3>Play & download</h3>
          <p>
            Scrolling synced lyrics, and the .mp3 saves straight to your Downloads folder.
          </p>
        </div>
      </section>

      <ShareTargetHint />
    </>
  );
}