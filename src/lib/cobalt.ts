/**
 * Zero-config Cobalt fallback.
 * Tries a hardcoded list of public Cobalt API instances (no keys, no env vars)
 * to obtain a direct audio download URL + metadata when yt-dlp is bot-blocked.
 */

const COBALT_INSTANCES = [
  "https://dog.kittycat.boo",
  "https://cobaltapi.kittycat.boo",
];

interface CobaltResult {
  audioUrl: string;
  title: string;
  artist: string;
}

/**
 * Derives a cover-art thumbnail URL for a supported source URL using pure
 * string/URL work (no API keys, no downloads). YouTube maps to the classic
 * i.ytimg.com hqdefault image; TikTok uses its embed cover endpoint (which
 * redirects to the CDN cover image). Returns undefined for sources we cannot
 * recognize so callers fall back to their placeholder.
 */
export function deriveThumbnailUrl(sourceUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return undefined;
  }

  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();

  if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) {
    const videoId =
      parsed.searchParams.get("v") ||
      (host === "youtu.be" ? parsed.pathname.split("/").filter(Boolean)[0] : undefined);
    if (videoId) return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  if (host === "tiktok.com" || host.endsWith(".tiktok.com") || host.endsWith(".tiktokcdn.com")) {
    const videoId = parsed.pathname.split("/").find((seg) => /^\d{15,20}$/.test(seg));
    if (videoId) return `https://www.tiktok.com/embed/${videoId}/cover`;
  }

  return undefined;
}

interface CobaltResponse {
  status: string;
  url?: string;
  filename?: string;
  error?: { code?: string };
}

function parseTitleArtist(filename: string): { title: string; artist: string } {
  // Strip .mp3 extension
  const base = filename.replace(/\.mp3$/i, "");
  const dashIdx = base.indexOf(" - ");
  if (dashIdx !== -1) {
    return { title: base.slice(0, dashIdx).trim(), artist: base.slice(dashIdx + 3).trim() };
  }
  return { title: base || "Unknown", artist: "Unknown artist" };
}

export async function getCobaltAudio(url: string): Promise<CobaltResult> {
  let lastError: unknown = null;

  for (const instance of COBALT_INSTANCES) {
    try {
      const res = await fetch(`${instance}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          url,
          downloadMode: "audio",
          audioFormat: "mp3",
          filenameStyle: "basic",
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const body = (await res.json()) as CobaltResponse;

      if (body.status === "tunnel" && body.url) {
        const { title, artist } = parseTitleArtist(body.filename ?? "");
        return { audioUrl: body.url, title, artist };
      }

      lastError = new Error(
        `Cobalt instance ${instance} returned status "${body.status}"` +
          (body.error?.code ? `: ${body.error.code}` : ""),
      );
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `All Cobalt instances failed. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
