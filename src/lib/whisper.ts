import { promises as fsp } from "node:fs";
import { buildLrc, captionsToPlain, type SrtLine } from "./lyrics";

/**
 * Whisper speech-to-text tier (100% server-side, Node-only module).
 *
 * KEYED EXTERNAL TIERS ONLY — the resource-heavy zero-key public Spaces race
 * was removed per the decentralized-architecture override:
 *   1. Groq (AI_WHISPER_API_KEY / AI_WHISPER_KEY / GROQ_API_KEY) — the
 *      fastest backend; whisper-large-v3-turbo on Groq's LPU answers ~20s
 *      clips in ~1s.
 *   2. Puter (PUTER_AUTH_TOKEN / AI_PUTER_TOKEN) — user-pays,
 *      keyless-to-dev; speech2txt (whisper-1) via @heyputer/puter.js.
 *
 * With no keys configured this module resolves to null immediately — the
 * lyrics pipeline no longer depends on transcription at all (LRCLIB is the
 * primary source). The module still serves audio IDENTIFICATION for
 * original-sound TikTok tracks when keys exist.
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

/** A timestamped segment as returned by a Whisper backend. */
interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  noSpeechProb?: number;
}

const NO_SPEECH_THRESHOLD = 0.5;

function whisperApiKey(): string | null {
  return (
    process.env.AI_WHISPER_API_KEY ||
    process.env.AI_WHISPER_KEY ||
    process.env.GROQ_API_KEY ||
    null
  );
}

/** Reads the Puter auth token from env (never hardcoded), else null. */
function puterApiToken(): string | null {
  return process.env.PUTER_AUTH_TOKEN || process.env.AI_PUTER_TOKEN || null;
}

/** Resolves to `null` after `ms` milliseconds (graceful timeout signal). */
function timeoutNull(ms: number): Promise<null> {
  return new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), ms);
  });
}

/**
 * Transcribes `mp3Path` into timed lyrics via the KEYED external tiers only.
 * Returns:
 *   - `null` on ANY failure (no keys, unreachable backend, timeout, network
 *     error) — a quiet no-op so callers fall through gracefully,
 *   - `{ synced, plain, isInstrumental: true }` when Whisper ran but found no
 *     usable speech (empty/bare segments),
 *   - `{ synced, plain, isInstrumental: false }` with the transcript otherwise.
 */
export async function whisperTranscribe(mp3Path: string): Promise<WhisperTranscribeResult | null> {
  try {
    const buffer = await fsp.readFile(mp3Path);

    // Keyed tiers only; whole tier runs under one 60s cap.
    const result = await Promise.race([
      runKeyedTiers(buffer),
      timeoutNull(60_000),
    ]);
    return result;
  } catch {
    // Never propagate a failure through to the route.
    return null;
  }
}

/**
 * Keyed tiers in order: Groq first (fastest), then the user-pays Puter tier.
 * No keys configured → immediate null (zero-cost no-op).
 */
async function runKeyedTiers(buffer: Buffer): Promise<WhisperTranscribeResult | null> {
  const apiKey = whisperApiKey();
  if (!apiKey && !puterApiToken()) return null;

  if (apiKey) {
    const viaGroq = await groqTranscribe(buffer, apiKey);
    if (viaGroq) return viaGroq;
  }

  const puterToken = puterApiToken();
  if (puterToken) {
    const viaPuter = await puterTranscribe(buffer, puterToken);
    if (viaPuter) return viaPuter;
  }

  return null;
}

/**
 * Groq's OpenAI-compatible transcriptions endpoint (verbose_json -> segments
 * -> timed LRC lines).
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

/**
 * User-pays Puter tier: @heyputer/puter.js speech2txt (whisper-1). Reached
 * after the Groq key path when a Puter token env is set. Any failure
 * (missing bundle, network, auth, empty transcript) resolves to null.
 */
async function puterTranscribe(
  buffer: Buffer,
  token: string | null,
): Promise<WhisperTranscribeResult | null> {
  const puterToken = token;
  if (!puterToken) return null;

  try {
    const { init } = await import("@heyputer/puter.js/src/init.cjs");
    const puter = init(puterToken);

    const model = process.env.AI_WHISPER_MODEL || "whisper-1";
    const transcript = await puter.ai.speech2txt(
      new File([new Uint8Array(buffer)], "audio.mp3", {
        type: "audio" + "/" + "mpeg",
      }),
      { model },
    );
    return puterResultToWhisper(transcript);
  } catch {
    // Network / auth / runtime errors never propagate to the route.
    return null;
  }
}

/**
 * Maps a Puter speech2txt result into the standardized result shape: explicit
 * `.segments` are preferred (same start/end/text parsing), else the plain
 * `.text` becomes a single t=0 segment. No usable text resolves to
 * { synced:null, plain:null, isInstrumental:true } via segmentsToResult.
 */
function puterResultToWhisper(transcript: unknown): WhisperTranscribeResult | null {
  const record =
    transcript && typeof transcript === "object" && !Array.isArray(transcript)
      ? (transcript as Record<string, unknown>)
      : null;

  const segments = record && Array.isArray(record.segments) ? record.segments : [];
  const mapped = segments
    .map(toSegment)
    .filter((seg): seg is TranscriptSegment => seg !== null);
  if (mapped.length) return segmentsToResult(mapped);

  const text = record && typeof record.text === "string" ? record.text : "";
  return segmentsToResult([{ start: 0, end: 0, text }]);
}

/** Coerces a raw segment item (tuple or object) into a TranscriptSegment. */
function toSegment(item: unknown): TranscriptSegment | null {
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

/** Maps parsed segments into the standardized result (instrumental on none). */
function segmentsToResult(segments: TranscriptSegment[]): WhisperTranscribeResult | null {
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
