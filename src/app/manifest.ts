import type { MetadataRoute } from "next";

// Chrome's Web Share Target manifest shape ("GET" + named params mapping).
// Next's MetadataRoute.Manifest models a stale draft, so we emit the real
// object and satisfy types with a cast.
export default function manifest(): MetadataRoute.Manifest {
  const shareTarget = {
    action: "/share",
    method: "GET",
    enctype: "application/x-www-form-urlencoded",
    params: {
      title: "title",
      text: "text",
      url: "url",
    },
  } as const;

  return {
    name: "VibeMusic — Audio Extractor & Player",
    short_name: "VibeMusic",
    description:
      "Extract the audio from any link, play it with synced lyrics and save the MP3 to your device.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0e0a1e",
    theme_color: "#0e0a1e",
    lang: "en",
    categories: ["music", "entertainment", "utilities"],
    shortcuts: [
      {
        name: "Extract audio",
        short_name: "Extract",
        description: "Paste a link and extract its audio",
        url: "/",
      },
    ],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
    share_target: shareTarget,
  } as MetadataRoute.Manifest & { share_target: typeof shareTarget } as unknown as MetadataRoute.Manifest;
}