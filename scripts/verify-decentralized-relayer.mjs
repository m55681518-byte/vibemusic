#!/usr/bin/env node
/**
 * verify-decentralized-relayer.mjs — acceptance gate for the "permanent build"
 * decentralized architecture override (freebuff-task-20260821-131500).
 *
 * Pins:
 *  G1  Piped instance pool exists (src/lib/piped.ts) with cycling fetcher.
 *  G2  YouTube extraction order is EXTERNAL-FIRST: piped -> cobalt -> yt-dlp
 *      (host yt-dlp demoted to last-resort backstop).
 *  G3  Lyrics pipeline is LRCLIB-first with NO whisper tiers (Gradio removed).
 *  G4  Gradio Whisper race removed from whisper.ts (no HF space URLs).
 *  G5  Lightweight oEmbed title resolution used for shorts/YouTube metadata.
 *  G6  Client IDB reads are batched (cursor batching for Android UI thread).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const read = (p) => readFileSync(path.join(root, p), "utf8");

let failures = 0;
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const pipedPath = path.join(root, "src", "lib", "piped.ts");
const hasPiped = existsSync(pipedPath);
const piped = hasPiped ? read("src/lib/piped.ts") : "";
const extract = read("src/lib/extract.ts");
const lyrics = read("src/lib/lyrics.ts");
const whisper = read("src/lib/whisper.ts");
const clientCache = read("src/lib/client-cache.ts");

// G1 — Piped pool + cycling fetcher.
check(
  "G1 piped.ts instance pool + cycling fetcher",
  hasPiped &&
    /PIPED_INSTANCES/.test(piped) &&
    /getPipedStreams|fetchPipedStreams/.test(piped) &&
    /audioStreams/.test(piped),
  "piped.ts missing or incomplete",
);

// G2 — external-first ordering for YouTube-family URLs: piped before cobalt
// before yt-dlp in the doExtract youtube branch.
{
  const ytBranch = extract.slice(
    Math.max(0, extract.indexOf("isYouTubeFamilyUrl(url)") - 200),
    extract.indexOf("Metadata guard") > 0
      ? extract.indexOf("Metadata guard")
      : extract.length,
  );
  const p = ytBranch.indexOf("tryPipedFallback");
  const c = ytBranch.indexOf("tryCobaltFallback");
  const y = ytBranch.indexOf("tryYtdlpDirect");
  check(
    "G2 youtube branch external-first: piped -> cobalt -> yt-dlp",
    p !== -1 && c !== -1 && y !== -1 && p < c && c < y,
    `order indexes piped=${p} cobalt=${c} ytdlp=${y}`,
  );
}

// G3 — lyrics pipeline: LRCLIB primary, no whisper anywhere in lyrics.ts.
check(
  "G3 lyrics pipeline LRCLIB-only (whisper removed)",
  !/whisper/i.test(lyrics) && /lrclib|LRCLIB/.test(lyrics),
  "lyrics.ts still references whisper",
);

// G4 — Gradio race removed from whisper.ts (no HF space endpoints left).
check(
  "G4 Gradio Whisper race removed",
  !/hf\.space|gradio|GRADIO|huggingface/i.test(whisper),
  "whisper.ts still contains Gradio/HF space machinery",
);

// G5 — oEmbed lightweight title resolution wired into extract.ts.
check(
  "G5 oEmbed title resolution present",
  /oembed/i.test(extract) && /youtubeOEmbed|fetchOEmbedTitle/.test(extract),
  "oEmbed helper missing from extract.ts",
);

// G6 — batched IDB cursor reads in client-cache.
check(
  "G6 client-cache batches cursor reads",
  /BATCH|batch|chunk/i.test(clientCache),
  "no batching markers in client-cache.ts",
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} gate check(s) FAILED — see above`);
  process.exit(1);
}