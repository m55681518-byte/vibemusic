import { promises as fsp } from "node:fs";
import { buildLrc, captionsToPlain, type SrtLine } from "./lyrics";

/**
 * Whisper speech-to-text fallback (free serverless: Groq / Hugging Face).
 *
 * Config comes from env ONLY — never hardcode a key:
 *   - AI_WHISPER_API_KEY (also accepts AI_WHISPER_KEY / GROQ_API_KEY)
 *   - AI_WHISPER_ENDPOINT (default: Groq OpenAI-compatible transcriptions)
 *   - AI_WHISPER_MODEL   (default: whisper-large-v3)
 *
 * The stored MP3 is POSTed as multipart form data; the verbose_json response's
 * `segments` (start/text/no_speech_prob) are mapped into timed LRC lines.
 * Any failure (missing key, network, HTTP error, timeout, fs error) resolves
 * to `null` — this tier never throws through to the route.
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
  text?: string;
  no_speech_prob?: number;
}

function whisperApiKey(): string | null {
  return (
    process.env.AI_WHISPER_API_KEY ||
    process.env.AI_WHISPER_KEY ||
    process.env.GROQ_API_KEY ||
    null
  );
}

const NO_SPEECH_THRESHOLD = 0.5;

/**
 * Transcribes `mp3Path` into timed lyrics. Returns:
 *   - `null` when no API key is configured or on ANY failure (quiet no-op),
 *   - `{ synced, plain, isInstrumental: true }` when Whisper ran but found no
 *     usable speech (empty segments, empty text, or no_speech_prob > 0.5 on
 *     every segment),
 *   - `{ synced, plain, isInstrumental: false }` with the transcript otherwise.
 */
export async function whisperTranscribe(mp3Path: string): Promise<WhisperTranscribeResult | null> {
  const apiKey = whisperApiKey();
  if (!apiKey) return null; // not configured → skip straight to the empty result

  const endpoint =
    process.env.AI_WHISPER_ENDPOINT || "https://api.groq.com/openai/v1/audio/transcriptions";
  const model = process.env.AI_WHISPER_MODEL || "whisper-large-v3";

  try {
    const buffer = await fsp.readFile(mp3Path);
    const form = new FormData();
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("file", new Blob([buffer]), "audio.mp3");

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

    const lines: SrtLine[] = useful.map((seg) => ({ start: seg.start, end: seg.start, text: seg.text }));
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
