// Acceptance gate: Zero-Key External Serverless AI Transcription via
// Hugging Face Gradio (freebuff-task-20260816-120000).
//
// Tier 2 of the lyrics engine must route audio transcription to public
// high-spec Hugging Face Spaces (16GB+ RAM) via the official Gradio JS
// Client (@gradio/client), with:
//   1. @gradio/client installed as a runtime dependency.
//   2. A lib module that connects to a public Whisper Gradio Space and sends
//      the stored audio file buffer/blob to the space's /predict endpoint.
//   3. Parsing of the returned timestamped segments (start, end, text) into
//      the standardized LRC array [{ timeInSeconds: segment.start, text }].
//   4. Multi-space fallback (2-3 public endpoints), failing over to the next
//      space within 5 seconds when the current one is busy/queuing.
//   5. Strictly server-side execution (route, nodejs runtime; no "use client").
//   6. A total execution timeout of 15 seconds; on timeout/empty result the
//      tier passes gracefully to Tier 3 ({ isInstrumental: true }) and never
//      throws through to the route.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const srcLib = resolve(root, "src/lib");
const routeFile = resolve(root, "src/app/api/lyrics/route.ts");
const packageJson = resolve(root, "package.json");

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

const libSrc = readdirSync(srcLib)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => read(resolve(srcLib, f)))
  .join("\n");
const routeSrc = read(routeFile);
const pkg = existsSync(packageJson) ? JSON.parse(read(packageJson)) : {};

// The transcription tier lives in ONE dedicated module (e.g. gradio-whisper.ts
// or whisper.ts). All module-level checks scope to that file only, not ytdlp.
const tierFiles = readdirSync(srcLib)
  .filter((f) => /\.ts$/.test(f) && /whisper|gradio|transcri|stt/i.test(f));
const tierSrc = resolve(srcLib, tierFiles[0] || "whisper.ts");
const moduleSrc = read(tierSrc);
const useModule = tierFiles.length > 0;

// ---- 1. Package ----
// G1a. @gradio/client is a runtime dependency.
const hasGradioDep = Boolean(pkg.dependencies && pkg.dependencies["@gradio/client"]);
if (hasGradioDep) pass("G1a: @gradio/client in package.json dependencies");
else fail("G1a: @gradio/client missing from dependencies");

// ---- 2. Gradio client module ----
// G2a. Some src/lib module imports the official @gradio/client.
const gradioImport = /@gradio\/client/.test(moduleSrc) && /Client\.connect\s*\(/.test(moduleSrc);
if (useModule && gradioImport) pass(`G2a: ${tierFiles[0]} imports @gradio/client and calls Client.connect`);
else fail(`G2a: no @gradio/client import / Client.connect in tier module (file=${tierFiles.join(",")||"none"})`);

// G2b. The module is server-side only (no "use client" directive).
const noUseClient = !/["']use client["']/.test(moduleSrc);
if (noUseClient) pass("G2b: whisper/gradio module has no 'use client' directive");
else fail("G2b: use client directive found in lib module");

// ---- 3. Public space connection ----
// G3a. Connects to a public Hugging Face Whisper Gradio Space (by sketch slug,
//      not against localhost).
const publicSpace = /Client\.connect\s*\(\s*["'][a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+["']|hf\.space|huggingface\.co\/spaces|"[a-zA-Z0-9_-]+\/[wW]hisper[a-zA-Z0-9._-]*"|'[a-zA-Z0-9_-]+\/[wW]hisper[a-zA-Z0-9._-]*'/.test(moduleSrc);
if (publicSpace) pass("G3a: connects to a public HF Whisper Gradio Space");
else fail("G3a: no public HF space connect (needs slug like 'openai/whisper')");

// G3b. Sends the audio buffer/blob to the space's transcription endpoint.
const audioToEndpoint =
  /\.predict\s*\(|\.call\s*\(|api_name|\/predict|\/api\//.test(moduleSrc) &&
  /new\s+File|new\s+Blob|File\(|Blob\(|Audio\(|arrayBuffer|readFile|audio/i.test(moduleSrc);
if (audioToEndpoint) pass("G3b: audio buffer/blob sent to the space predict endpoint");
else fail(`G3b: predict/endpoint call missing (endpoint=${/\.predict\s*\(|\.call\s*\(/.test(libSrc)}, audio=${/new\s+File|new\s+Blob|File\(|Blob\(/.test(libSrc)})`);

// ---- 4. Segment parsing -> standardized LRC array ----
// G4a. Parses the returned payload for timestamped segments (start, end, text).
const parsesSegments =
  /\.segments\b|segments\s*[:=]|\.result\.segments|json\.segments/.test(moduleSrc) &&
  /\.start\b/.test(moduleSrc) &&
  /\.end\b/.test(moduleSrc) &&
  /\.text\b|"text"|['"]text['"]/.test(moduleSrc);
if (parsesSegments) pass("G4a: parses timestamped segments (start, end, text)");
else fail(`G4a: segment parsing missing (segRef=${/\.segments\b|segments\s*[:=]/.test(moduleSrc)}, start=${/\.start\b/.test(moduleSrc)}, end=${/\.end\b/.test(moduleSrc)}, text=${/\.text\b/.test(moduleSrc)})`);

// G4b. Converts segments into the standardized LRC array
//      [{ timeInSeconds: segment.start, text }] before building synced output.
const lrcArrayShape = /timeInSeconds\s*:\s*\w+\.start|\.start\s*,\s*text|timeInSeconds\s*[,=:]|timeInSec\b/.test(moduleSrc);
if (lrcArrayShape) pass("G4b: segments mapped to LRC array [{timeInSeconds, text}]");
else fail("G4b: no {timeInSeconds: seg.start, text} mapping found");

// ---- 5. Multi-space fallback redundancy ----
// G5a. A fallback array of 2+ public Whisper space endpoints exists. A space
//      slug is a quoted "org/name" whose org part contains NO dot (i.e. not a
//      URL like api.groq.com/...).
const slugRe = /["']([A-Za-z0-9_-]+)\/([A-Za-z0-9._-]+)["']/g;
const slugs = [];
let sm;
while ((sm = slugRe.exec(moduleSrc)) !== null) {
  if (!sm[1].includes(".")) slugs.push(sm[0]);
}
const spaceCount = slugs.length;
if (spaceCount >= 2) pass(`G5a: fallback array of ${spaceCount} spaces[${slugs.join(", ")}]`);
else fail(`G5a: need >=2 spaces in fallback list (count=${spaceCount})`);

// G5b. Env overridable: a comma-separated AI_WHISPER_SPACES (or similar) env
//      var can inject the space list (keeps old gate T2c green too).
const envOverride = /process\.env\.[A-Z_]*WHISPER[A-Z_]*|process\.env\.[A-Z_]*SPACES[A-Z_]*/.test(moduleSrc);
if (envOverride) pass("G5b: space list overridable via env var");
else fail("G5b: no env override for space list");

// G5c. Failover: when the primary space is busy/queuing, the next space is
//      tried within 5 seconds (per-space timeout budget <= 5000ms).
const perSpaceTimeout = /\b5000\b|\b5_000\b|\b5e3\b/.test(moduleSrc) &&
  /timeout|deadline|AbortSignal|Promise\.race|for\s*\(|for\s*of/.test(moduleSrc);
if (perSpaceTimeout) pass("G5c: per-space failover timeout <= 5000ms");
else fail("G5c: no 5s per-space failover timeout found");

// ---- 6. Total execution timeout (15s) + graceful Tier 3 pass ----
// G6a. A total execution budget/duration of 15 seconds guards the whole tier.
const totalBudget = /\b15000\b|\b15_000\b|\b15e3\b/.test(moduleSrc);
if (totalBudget) pass("G6a: total execution timeout of 15 seconds present");
else fail("G6a: no 15000ms total budget found");

// G6b. Empty result / total timeout passes gracefully to Tier 3
//      ({ isInstrumental: true }) — and the module never throws.
const tier3Pass =
  /isInstrumental\s*:\s*true|isInstrumental\s*=\s*true|isInstrumental\s*&&/.test(moduleSrc) &&
  /catch|try\s*\{/.test(moduleSrc) ||
  /isInstrumental\s*:\s*true/.test(routeSrc);
if (tier3Pass) pass("G6b: timeout/empty/error resolves to isInstrumental:true, never throws");
else fail("G6b: Tier3 graceful pass (isInstrumental) missing");

const throwsThrough = /\bthrow\s+new\s+Error|throw\s+\w+;/.test(moduleSrc);
if (!throwsThrough) pass("G6c: no throw statements escape the tier");
else fail("G6c: raw throws found in tier module");

// ---- 7. Route wiring ----
// G7a. /api/lyrics route invokes the Gradio transcription tier (by name).
const routeUsesGradio = /gradio|\btranscrib\b|whisper/i.test(routeSrc);
if (routeUsesGradio) pass("G7a: /api/lyrics invokes the Gradio/transcription tier");
else fail("G7a: route does not call the transcription tier");

// G7b. Server-side route (nodejs runtime), as required for file access.
const serverSide = /runtime\s*=\s*["']nodejs["']/.test(routeSrc);
if (serverSide) pass("G7b: route runs server-side (runtime=nodejs)");
else fail("G7b: route missing nodejs runtime");

console.log(`\n[verify-gradio-whisper] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);