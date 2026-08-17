import { promises as fsp } from "node:fs";
import { Client } from "@gradio/client";
import { buildLrc, captionsToPlain, type SrtLine } from "./lyrics";

/**
 * Whisper speech-to-text tier (100% server-side, Node-only module).
 *
 * PRIMARY: zero-key public Hugging Face Gradio Spaces via the official
 * @gradio/client. The stored MP3 is uploaded to a public Whisper space, the
 * transcription endpoint is discovered through view_api() (never assumed),
 * and the returned timestamped segments (start/end/text) are parsed into the
 * standardized LRC array [{ timeInSeconds: seg.start, end: seg.end, text: seg.text }]
 * before being rendered as synced LRC via buildLrc.
 *
 *   - Space list: AI_WHISPER_SPACES (comma-separated env override), else the
 *     built-in public fallback array below. No API key or token is needed and
 *     none is ever hardcoded.
 *   - Parallel race: ALL spaces are fired at once, each under its own
 *     PER_SPACE_TIMEOUT_MS (14000ms) race; the FIRST space to return a real
 *     transcript wins immediately, so a broken/queued space no longer burns
 *     the whole budget before a healthy one is reached.
 *   - Budget: a TOTAL_TIMEOUT_MS (15000ms) race guards the whole tier.
 *
 * LAST RESORT: the legacy Groq key path (AI_WHISPER_API_KEY /
 * AI_WHISPER_KEY / GROQ_API_KEY) when a key IS configured.
 *
 * Every failure mode (timeout, empty result, network/HTTP error) resolves
 * gracefully to `null` or { synced:null, plain:null, isInstrumental:true } —
 * this module never propagates an exception to the route.
 */

export interface WhisperSegment {
  /** Seconds from the start of the audio where the segment begins. */
  start: number;
  text: string;
}

export interface WhisperTranscribeResult {
  /** Synced LRC string ("[mm:ss.mmm] text" lines) or null when instrumental. */
  synced: string | null;
  /** Plain joined transcript or null when instrumental. */
  plain: string | null;
  /** True when Whisper found NO usable speech (silence/instrumental). */
  isInstrumental: boolean;
}

interface VerboseJsonSegment {
  start?: number;
  end?: number;
  text?: string;
  no_speech_prob?: number;
}

/** A timestamped segment as returned by a Gradio Whisper space. */
interface GradioSegment {
  start: number;
  end: number;
  text: string;
  noSpeechProb?: number;
}

/** Minimal shape of the view_api() result we rely on. */
interface GradioEndpointInfo {
  parameters: { label: string; type: string }[];
}

interface GradioApiInfo {
  named_endpoints: Record<string, GradioEndpointInfo>;
  unnamed_endpoints: Record<string, GradioEndpointInfo>;
}

/** Public high-spec Whisper Spaces, tried in order (env-overridable). */
const DEFAULT_WHISPER_SPACES = [
  "hf-audio/whisper-large-v3-turbo",
  "openai/whisper",
  "hf-audio/whisper-large-v3",
];

/** Fail over to the next space when one is busy/queuing after this long. */
const PER_SPACE_TIMEOUT_MS = 14000;

/** Hard ceiling for the whole Tier 2 execution (Gradio + Groq). */
const TOTAL_TIMEOUT_MS = 15000;

const NO_SPEECH_THRESHOLD = 0.5;

function whisperApiKey(): string | null {
  return (
    process.env.AI_WHISPER_API_KEY ||
    process.env.AI_WHISPER_KEY ||
    process.env.GROQ_API_KEY ||
    null
  );
}

/** Resolves to `null` after `ms` milliseconds (graceful timeout signal). */
function timeoutNull(ms: number): Promise<null> {
  return new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), ms);
  });
}

/**
 * Resolves the ordered list of Whisper space slugs: AI_WHISPER_SPACES
 * (comma-separated) when set, otherwise the built-in public spaces.
 */
function whisperSpaces(): string[] {
  const raw = process.env.AI_WHISPER_SPACES;
  if (raw && raw.trim()) {
    const parsed = raw
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean);
    if (parsed.length) return parsed;
  }
  return DEFAULT_WHISPER_SPACES;
}

/**
 * Transcribes `mp3Path` into timed lyrics. Returns:
 *   - `null` on ANY failure (unreachable space, timeout, missing key, network
 *     error) — a quiet no-op so the route falls through gracefully,
 *   - `{ synced, plain, isInstrumental: true }` when Whisper ran but found no
 *     usable speech (empty/bare segments),
 *   - `{ synced, plain, isInstrumental: false }` with the transcript otherwise.
 */
export async function whisperTranscribe(mp3Path: string): Promise<WhisperTranscribeResult | null> {
  try {
    const buffer = await fsp.readFile(mp3Path);

    // The whole tier (Gradio spaces + Groq fallback) runs under one 15s cap.
    const result = await Promise.race([
      runAllTiers(buffer),
      timeoutNull(TOTAL_TIMEOUT_MS),
    ]);
    return result;
  } catch {
    // Never propagate a failure through to the route.
    return null;
  }
}

/** Zero-key Gradio spaces first, then the optional keyed Groq path. */
async function runAllTiers(buffer: Buffer): Promise<WhisperTranscribeResult | null> {
  const viaSpaces = await transcribeViaGradio(buffer);
  if (viaSpaces) return viaSpaces;

  const apiKey = whisperApiKey();
  if (!apiKey) return null; // no key → nothing else to try
  return groqTranscribe(buffer, apiKey);
}

/**
 * Fires every public space IN PARALLEL; the first space that answers wins.
 *
 * Sequential failover wasted the 15s total budget on dead/queued spaces: the
 * broken hf-audio/whisper-large-v3-turbo (503) and the ZeroGPU-queued
 * openai/whisper were consumed before hf-audio/whisper-large-v3 (which
 * answers in ~9s) was ever reached — whisperTranscribe returned null in
 * practice. Each space still runs under its own PER_SPACE_TIMEOUT_MS race;
 * Promise.any resolves with the FIRST space to return a real transcript (a
 * null outcome counts as a rejection so it never wins), and the outer
 * TOTAL_TIMEOUT_MS race still caps the whole tier.
 */
async function transcribeViaGradio(buffer: Buffer): Promise<WhisperTranscribeResult | null> {
  const attempts = whisperSpaces().map((slug) =>
    Promise.race([
      transcribeWithSpace(slug, buffer),
      timeoutNull(PER_SPACE_TIMEOUT_MS),
    ]),
  );

  // Promise.any = first non-null success in time; all-null (or all rejected)
  // settles to null via the catch. No throw escapes the tier.
  const identified = await Promise.any(
    attempts.map(async (attempt): Promise<WhisperTranscribeResult> => {
      const outcome = await attempt;
      if (outcome) return outcome;
      return Promise.reject<WhisperTranscribeResult>(null);
    }),
  ).catch(() => null);
  return identified;
}

/**
 * Connects to one space, discovers the transcription endpoint via view_api(),
 * uploads the audio buffer and parses the returned segments. Any failure for
 * this space resolves to `null` so the caller can move to the next space.
 */
async function transcribeWithSpace(
  slug: string,
  buffer: Buffer,
): Promise<WhisperTranscribeResult | null> {
  try {
    const app = await Client.connect(slug);
    const api = (await app.view_api()) as unknown as GradioApiInfo;
    const endpoint = pickTranscribeEndpoint(api);
    if (!endpoint) return null;

    const audioFile = new File([new Uint8Array(buffer)], "audio.mp3", { type: "audio" + "/" + "mpeg" });
    const payload = endpoint.parameters.map((param) =>
      param.type === "string" ? "transcribe" : audioFile,
    );

    const response = await app.predict(endpoint.name, payload);
    const segments = extractSegments(response.data);
    return segmentsToResult(segments);
  } catch {
    // This space failed (down, cold start, auth) — the next one gets a shot.
    return null;
  }
}

/**
 * Picks the audio-transcription endpoint from the space's API info instead of
 * hardcoding /predict: prefer an endpoint named like "transcribe"/"predict"
 * whose first parameter is the audio file, else any endpoint with a non-string
 * first parameter.
 */
function pickTranscribeEndpoint(api: GradioApiInfo): { name: string; parameters: { label: string; type: string }[] } | null {
  const entries = [
    ...Object.entries(api.named_endpoints),
    ...Object.entries(api.unnamed_endpoints),
  ];
  if (!entries.length) return null;

  const audioFirst = entries.filter(
    ([, ep]) => ep.parameters.length > 0 && ep.parameters[0].type !== "string",
  );
  const pool = audioFirst.length ? audioFirst : entries;

  const preferred = pool.find(([name]) => /transcrib|predict/i.test(name));
  const [name, ep] = preferred ?? pool[0];
  return { name, parameters: ep.parameters ?? [] };
}

/**
 * Normalizes a Whisper payload into timestamped segments. Spaces differ: some
 * return (transcription, segments) tuples of [start, end, text] triples (or
 * {start, end, text} objects), others return plain text only. Explicit
 * segments are preferred; a bare string becomes a single segment at t=0.
 */
function extractSegments(data: unknown): GradioSegment[] {
  const items = Array.isArray(data) ? data : [data];

  // 1) A record carrying an explicit `segments` field (e.g. response.segments).
  for (const item of items) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      const raw = record.segments;
      if (Array.isArray(raw)) {
        const mapped = raw
          .map(toSegment)
          .filter((seg): seg is GradioSegment => seg !== null);
        if (mapped.length) return mapped;
      }
    }
  }

  // 2) An array of [start, end, text] triples / {start, end, text} objects.
  for (const item of items) {
    if (Array.isArray(item)) {
      const mapped = item
        .map(toSegment)
        .filter((seg): seg is GradioSegment => seg !== null);
      if (mapped.length) return mapped;
    }
  }

  // 3) Fallback: plain text transcription becomes one segment starting at 0.
  const text = items.find((item): item is string => typeof item === "string") ?? "";
  return [{ start: 0, end: 0, text }];
}

/** Coerces a raw segment item (tuple or object) into a GradioSegment. */
function toSegment(item: unknown): GradioSegment | null {
  if (Array.isArray(item)) {
    const [start, end, text] = item as unknown[];
    if (typeof start === "number" && typeof end === "number" && typeof text === "string") {
      return { start, end, text };
    }
    return null;
  }
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : "";
    const start = typeof record.start === "number" ? record.start : 0;
    const end = typeof record.end === "number" ? record.end : start;
    const noSpeechProb =
      typeof record.no_speech_prob === "number"
        ? record.no_speech_prob
        : typeof record.noSpeechProb === "number"
          ? record.noSpeechProb
          : undefined;
    return { start, end, text, noSpeechProb };
  }
  return null;
}

/** Whisper voices pure silence / a bare tone as "." or "" — not lyrics. */
function isBareText(text: string): boolean {
  return text.length === 0 || /^[.\s]+$/.test(text);
}

/** Maps parsed segments into the standardized result (Tier 3 on no speech). */
function segmentsToResult(segments: GradioSegment[]): WhisperTranscribeResult | null {
  const useful = segments
    .map((seg) => ({
      start: Number.isFinite(seg.start) && seg.start >= 0 ? seg.start : 0,
      end: Number.isFinite(seg.end) ? seg.end : seg.start,
      text: seg.text.trim(),
      noSpeechProb: seg.noSpeechProb,
    }))
    .filter(
      (seg) =>
        !isBareText(seg.text) &&
        (seg.noSpeechProb === undefined || seg.noSpeechProb <= NO_SPEECH_THRESHOLD),
    );

  if (!useful.length) {
    // Whisper returned zero usable segments — the audio has no detected speech.
    return { synced: null, plain: null, isInstrumental: true };
  }

  // Standardized LRC array [{ timeInSeconds, end, text }] before building synced LRC.
  const lrcLines = useful.map((seg) => ({ timeInSeconds: seg.start, end: seg.end, text: seg.text }));
  const lines: SrtLine[] = lrcLines.map((line) => ({
    start: line.timeInSeconds,
    end: Number.isFinite(line.end) ? line.end : line.timeInSeconds,
    text: line.text,
  }));

  return {
    synced: buildLrc(lines),
    plain: captionsToPlain(lines),
    isInstrumental: false,
  };
}

/**
 * Legacy keyed fallback: Groq's OpenAI-compatible transcriptions endpoint
 * (verbose_json -> segments -> timed LRC lines). Only reached when a key env
 * is set and the zero-key Gradio tier produced nothing.
 */
async function groqTranscribe(buffer: Buffer, apiKey: string): Promise<WhisperTranscribeResult | null> {
  const endpoint =
    process.env.AI_WHISPER_ENDPOINT || "https://api.groq.com/openai/v1/audio/transcriptions";
  const model = process.env.AI_WHISPER_MODEL || "whisper-large-v3";

  try {
    const form = new FormData();
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("file", new Blob([new Uint8Array(buffer)]), "audio.mp3");

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { segments?: VerboseJsonSegment[] };
    const segments = Array.isArray(json.segments) ? json.segments : [];
    if (!segments.length) {
      // Whisper returned zero segments — the audio has no detected speech.
      return { synced: null, plain: null, isInstrumental: true };
    }

    const mappedSegments = segments.map((seg) => ({
      start: typeof seg.start === "number" ? seg.start : 0,
      end: typeof seg.end === "number" ? seg.end : typeof seg.start === "number" ? seg.start : 0,
      text: (seg.text ?? "").trim(),
      noSpeechProb: seg.no_speech_prob,
    }));
    const useful = mappedSegments.filter(
      (seg) =>
        seg.text.length > 0 &&
        (seg.noSpeechProb === undefined || seg.noSpeechProb <= NO_SPEECH_THRESHOLD),
    );

    if (!useful.length) {
      // Every segment was empty/whitespace or flagged as non-speech.
      return { synced: null, plain: null, isInstrumental: true };
    }

    const lines: SrtLine[] = useful.map((seg) => ({
      start: seg.start,
      end: seg.end ?? seg.start,
      text: seg.text,
    }));
    return {
      synced: buildLrc(lines),
      plain: captionsToPlain(lines),
      isInstrumental: false,
    };
  } catch {
    // Network / HTTP / timeout / fs errors never propagate to the route.
    return null;
  }
}
