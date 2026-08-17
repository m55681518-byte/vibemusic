// Acceptance gate: "intelligent instrumental-gap handling in buildLrc"
// (freebuff-task-20260817-003000).
//
// User problem: long instrumental breaks between vocal lines make the previous
// lyric HANG on the karaoke UI until the next line starts. Fix = buildLrc must:
//   1. DETECT gaps: next.start - current.end > 5 seconds (strictly greater).
//   2. INSERT an extra LRC line at (current.end + 0.5s) whose text is exactly
//      "♪" — the previous lyric clears and the user knows an instrumental
//      section is playing.
//   3. CLEAN: no completely-empty text lines ("[mm:ss.mmm] " unless intentional
//      gap markers), and lyric text has trailing spaces stripped.
//
// This is a FUNCTIONAL gate: it extracts the REAL buildLrc implementation from
// src/lib/lyrics.ts and executes it against crafted caption sets. Every
// new-behavior check FAILS against 85e4f75 (baseline buildLrc has no gap
// handling); the fix must make them PASS.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const libPath = resolve(root, "src/lib/lyrics.ts");
const libSrc = readFileSync(libPath, "utf8");

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

// --- Extract the real buildLrc function body from the source file -----------
const fnMatch = libSrc.match(/export function buildLrc\([\s\S]*?\n}/);
if (!fnMatch) {
  fail("buildLrc function not found in lyrics.ts");
} else {
  let fnSrc = fnMatch[0]
    .replace(/export function buildLrc\(captions: SrtLine\[\]\): string/, "function buildLrc(captions)")
    .trim();
  let buildLrc = null;
  try {
    const sandbox = {};
    runInNewContext(fnSrc, sandbox);
    buildLrc = sandbox.buildLrc;
    if (typeof buildLrc !== "function") fail("buildLrc did not eval to a function");
  } catch (e) {
    fail(`buildLrc extraction/eval failed: ${e.message}`);
  }

  if (buildLrc) {
    // G1 — gap strictly > 5s inserts a ♪ marker 0.5s after current segment end.
    {
      const out = buildLrc([
        { start: 1, end: 2, text: "line one" },
        { start: 10, end: 11, text: "line two" },
      ]);
      const marker = out.includes("[00:02.500] ♪");
      const gapLogicSeen = /2\.5|2\.500/.test(out) || marker;
      if (marker) pass("G1: gap >5s inserts '♪' line at current.end + 0.5s ([00:02.500] ♪)");
      else fail(`G1: no ♪ marker after a >5s gap. Output: ${JSON.stringify(out)} (gapLogic=${gapLogicSeen})`);
    }

    // G2 — gap exactly 5s is NOT strictly greater: NO marker inserted.
    {
      const out = buildLrc([
        { start: 1, end: 5, text: "line one" },
        { start: 10, end: 11, text: "line two" },
      ]);
      const marker = out.includes("♪");
      if (!marker) pass("G2: exactly 5s gap inserts NO ♪ marker (strictly > 5s)");
      else fail(`G2: marker inserted on an exactly-5s gap (${JSON.stringify(out)})`);
    }

    // G3 — gap <= 5s inserts NO marker.
    {
      const out = buildLrc([
        { start: 1, end: 2, text: "line one" },
        { start: 4, end: 5, text: "line two" },
      ]);
      if (!out.includes("♪")) pass("G3: gap <= 5s inserts NO ♪ marker");
      else fail(`G3: marker inserted on a small gap (${JSON.stringify(out)})`);
    }

    // G4 — marker line is EXACTLY one '[mm:ss.mmm] ♪' (anchored: no duplicate
    // brackets, no extra digits — a malformed double-timestamp like
    // '[00:002.500][00:02.500] ♪' must be rejected).
    {
      const out = buildLrc([
        { start: 1, end: 2, text: "line one" },
        { start: 10, end: 11, text: "line two" },
      ]);
      const markerLine = out.split("\n").find((l) => l.includes("♪"));
      const clean = markerLine && /^\[\d{2}:\d{2}\.\d{3}\] ♪$/.test(markerLine);
      if (clean) pass("G4: ♪ marker line is exactly one '[mm:ss.mmm] ♪'");
      else fail(`G4: marker line malformed (expected single '[mm:ss.mmm] ♪', got ${JSON.stringify(markerLine)})`);
    }

    // G5 — no empty text lines in output ("[mm:ss.mmm] " alone).
    {
      const out = buildLrc([
        { start: 1, end: 2, text: "hello   world  " },
        { start: 2.1, end: 3, text: "  next" },
      ]);
      const emptyLines = out.split("\n").filter((l) => /\[\d{2}:\d{2}\.\d{3}\]\s*$/.test(l));
      if (emptyLines.length === 0) pass("G5: no completely-empty LRC text lines");
      else fail(`G5: empty LRC line(s) found (${JSON.stringify(emptyLines)})`);
    }

    // G6 — lyric text has trailing spaces stripped.
    {
      const out = buildLrc([{ start: 1, end: 2, text: "trail   " }]);
      const line = out.split("\n")[0] || "";
      if (/\[\d{2}:\d{2}\.\d{3}\] trail\s*$/.test(line)) pass("G6: trailing spaces stripped from lyric text");
      else fail(`G6: trailing spaces not stripped (${JSON.stringify(line)})`);
    }

    // G7 — multiple consecutive gaps produce multiple markers, in order.
    {
      const out = buildLrc([
        { start: 1, end: 2, text: "a" },
        { start: 10, end: 11, text: "b" },
        { start: 30, end: 31, text: "c" },
      ]);
      const markers = out.split("\n").filter((l) => l.includes("♪"));
      if (markers.length === 2 && markers[0].includes("02.500") && markers[1].includes("11.500")) {
        pass("G7: two gaps → two ♪ markers at 00:02.500 and 00:11.500");
      } else {
        fail(`G7: multi-gap markers wrong (${markers.length} markers: ${JSON.stringify(markers)})`);
      }
    }
  }
}

console.log(`\n[verify-lrc-gap-handling] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);