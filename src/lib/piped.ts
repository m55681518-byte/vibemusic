/**
 * Piped instance pool — decentralized YouTube media extraction.
 *
 * The server acts ONLY as a relayer: it cycles public Piped API instances,
 * asks each for the video's stream manifest (/streams/{videoId}), and picks
 * the best audio stream URL (which Piped serves through its own proxy, so
 * our host IP never touches YouTube directly). No yt-dlp, no local scraping.
 *
 * Instances are cycled round-robin like the cobalt pool; failures fall
 * through to the next instance.
 */

interface PipedInstance {
  baseUrl: string;
}

/**
 * Public Piped API instances (2026-08 live probe: most were gated/down —
 * the pool cycles and skips failures automatically; any instance that
 * recovers starts serving again without a redeploy).
 */
const PIPED_INSTANCES: ReadonlyArray<PipedInstance> = [
  { baseUrl: "https://pipedapi.kavin.rocks" },
  { baseUrl: "https://pipedapi.adminforge.de" },
  { baseUrl: "https://pipedapi.drgns.space" },
  { baseUrl: "https://pipedapi.orangenet.cc" },
  { baseUrl: "https://api.piped.private.coffee" },
  { baseUrl: "https://pipedapi.ducks.party" },
  { baseUrl: "https://pipedapi.reallyaweso.me" },
];

// Round-robin cursor across calls.
let roundRobinIndex = 0;

export interface PipedAudioResult {
  audioUrl: string;
  title: string;
  artist: string;
  durationSeconds?: number;
}

interface PipedStream {
  url: string;
  bitrate?: number | string;
  mimeType?: string;
  format?: string;
  quality?: string;
}

interface PipedStreamsResponse {
  title?: string;
  uploader?: string;
  duration?: number;
  audioStreams?: PipedStream[];
}

function pickBestAudio(streams: PipedStream[] | undefined): PipedStream | null {
  if (!streams || streams.length === 0) return null;
  const audioOnly = streams.filter((s) => (s.mimeType || s.format || "").includes("audio"));
  const pool = audioOnly.length ? audioOnly : streams;
  return pool.reduce((best, cur) => {
    const b = Number(best.bitrate) || 0;
    const c = Number(cur.bitrate) || 0;
    return c > b ? cur : best;
  }, pool[0]);
}

/**
 * Queries every Piped instance (round-robin start). Returns the FIRST
 * instance that yields a usable audio stream URL. Throws only when no
 * instance could serve the request.
 */
export async function getPipedStreams(url: string): Promise<PipedAudioResult> {
  let lastError: unknown = null;

  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error(`Piped: not a YouTube URL: ${url}`);

  const start = roundRobinIndex++ % PIPED_INSTANCES.length;
  const order = [...PIPED_INSTANCES.slice(start), ...PIPED_INSTANCES.slice(0, start)];

  for (const instance of order) {
    try {
      const res = await fetch(`${instance.baseUrl}/streams/${videoId}`, {
        headers: { Accept: "application/json", "User-Agent": BROWSER_USER_AGENT },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        lastError = new Error(`Piped instance ${instance.baseUrl} failed with HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json().catch(() => null)) as PipedStreamsResponse | null;
      const best = pickBestAudio(body?.audioStreams);
      if (!body || !best?.url) {
        lastError = new Error(`Piped instance ${instance.baseUrl} returned no audio streams`);
        continue;
      }
      return {
        audioUrl: best.url,
        title: (body.title || "").trim(),
        artist: (body.uploader || "").trim(),
        durationSeconds:
          typeof body.duration === "number" && body.duration > 0 ? body.duration : undefined,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    `All Piped instances failed. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function extractYouTubeId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id || null;
    }
    if (host.endsWith("youtube.com")) {
      const v = parsed.searchParams.get("v");
      if (v) return v;
      const m = parsed.pathname.match(/\/(shorts|embed|live)\/([^/?]+)/);
      if (m) return m[2];
    }
    return null;
  } catch {
    return null;
  }
}

// Same browser UA convention as the cobalt pool.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
