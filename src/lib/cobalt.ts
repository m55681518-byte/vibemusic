/**
 * Zero-config Cobalt pool.
 * Tries a hardcoded list of public Cobalt API instances (no keys, no env vars)
 * to obtain a direct audio download URL + metadata when the source must go
 * through an external API. Requests rotate round-robin across the pool.
 */

interface CobaltInstance {
  baseUrl: string;
  /**
   * New cobalt API (v10+) instances accept `isAudioOnly` in the request body.
   * The legacy instances (dog/cobaltapi.kittycat.boo) reject it with
   * error.api.invalid_body — verified live 2026-08-16 — so they get the
   * downloadMode/audioFormat/filenameStyle fields only.
   */
  supportsAudioOnly?: boolean;
}

const COBALT_INSTANCES: ReadonlyArray<CobaltInstance> = [
  { baseUrl: "https://dog.kittycat.boo" },
  { baseUrl: "https://cobaltapi.kittycat.boo" },
  // Official instance (api.cobalt.tools). It answers HTTP but now requires a
  // JWT/API key for direct API access, so it fails fast with a clear error
  // code while the community instances above carry the load — it is kept so
  // the redundancy list has a stable third, confirmed-reachable endpoint.
  { baseUrl: "https://api.cobalt.tools", supportsAudioOnly: true },
  // Live community instance running the new cobalt API (auth-gated like the
  // official one: answers HTTP, fails fast with error.api.auth.key.missing
  // when unkeyed). Verified reachable 2026-08-16; the previously suggested
  // https://cobalt-api.kwiatekq.dev no longer resolves (NXDOMAIN).
  { baseUrl: "https://cobalt.aelew.dev", supportsAudioOnly: true },
];

// Round-robin cursor: each call starts from the next instance so load spreads
// across the pool instead of hammering the first entry every time.
let roundRobinIndex = 0;

// A real desktop Chrome UA string. Some cobalt instances / CDN frontends 403
// or bot-challenge requests that don't look like a browser, so both the API
// POST and the tunnel download send this.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface CobaltResult {
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

/**
 * Queries every cobalt instance (round-robin start) and returns ALL tunnel
 * candidates in pool order. Deliberately NOT return-on-first-tunnel: some
 * instances (e.g. dog.kittycat.boo) serve a tunnel URL whose body is EMPTY
 * (HTTP 200, 0 bytes), so the caller must download each candidate and only
 * accept one that actually yields bytes — falling through to the next
 * instance's tunnel when a body comes back empty. Throws only when no
 * instance returned a tunnel at all.
 */
export async function getCobaltAudio(url: string): Promise<CobaltResult[]> {
  const candidates: CobaltResult[] = [];
  let lastError: unknown = null;

  const start = roundRobinIndex++ % COBALT_INSTANCES.length;
  const order = [...COBALT_INSTANCES.slice(start), ...COBALT_INSTANCES.slice(0, start)];

  for (const instance of order) {
    try {
      const res = await fetch(`${instance.baseUrl}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          // Send a browser UA so instances / CDN frontends answer instead of
          // rejecting the request with a 403 or bot challenge.
          "User-Agent": BROWSER_USER_AGENT,
        },
        body: JSON.stringify({
          url,
          ...(instance.supportsAudioOnly ? { isAudioOnly: true } : {}),
          downloadMode: "audio",
          audioFormat: "mp3",
          filenameStyle: "basic",
        }),
        signal: AbortSignal.timeout(30_000),
      });

      // Surface the HTTP status (403/429/500) in the error label so the UI can
      // say "Cobalt 403", then keep iterating the rest of the pool for a
      // working instance.
      if (!res.ok) {
        lastError = new Error(
          `Cobalt instance ${instance.baseUrl} failed with HTTP ${res.status}`,
        );
        continue;
      }

      const body = (await res.json().catch(() => null)) as CobaltResponse | null;

      if (body?.status === "tunnel" && body.url) {
        const { title, artist } = parseTitleArtist(body.filename ?? "");
        candidates.push({ audioUrl: body.url, title, artist });
      } else {
        lastError = new Error(
          `Cobalt instance ${instance.baseUrl} returned status "${body?.status ?? "unknown"}"` +
            (body?.error?.code ? `: ${body.error.code}` : ""),
        );
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `All Cobalt instances failed. Last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  return candidates;
}
