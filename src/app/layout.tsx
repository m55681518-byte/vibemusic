import type { Metadata } from "next";
import "./globals.css";
import "./app.css";
import { SwRegister } from "@/components/SwRegister";
import { Logo } from "@/components/Logo";
import { AmbientBackdrop } from "@/components/AmbientBackdrop";

export const metadata: Metadata = {
  applicationName: "VibeMusic",
  manifest: "/manifest.webmanifest",
  title: {
    default: "VibeMusic — Audio Extractor & Player",
    template: "%s · VibeMusic",
  },
  description:
    "Extract the audio from any link — TikTok, YouTube, Instagram, SoundCloud and more — get a tagged MP3 with cover art, synced lyrics and a one-tap download.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "VibeMusic",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a className="brand" href="/">
            <Logo size={30} />
            <span>VibeMusic</span>
          </a>
          <nav className="nav">
            <a href="/#how">How it works</a>
          </nav>
        </header>
        <AmbientBackdrop />
        {children}
        <footer className="foot">
          <p>VibeMusic · extract, tag, play, keep.</p>
        </footer>
        <SwRegister />
      </body>
    </html>
  );
}