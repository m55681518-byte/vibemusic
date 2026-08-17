// Acceptance gate: "whisper sync fix — segments must keep their real end time"
// (freebuff-task-20260817-123318).
//
// USER BUG: karaoke lyrics are out of sync — during beats/instrumental the
// lyrics keep moving forward / jump ahead. Verified root cause in src/lib/whisper.ts:
//   - segmentsToResult() maps each whisper segment into an SrtLine with
//     `end: line.timeInSeconds` — i.e. end := start, the REAL seg.end is DROPPED.
//   - groqTranscribe() does the same: `end: seg.start`.
// buildLrc (src/lib/lyrics.ts) then computes instrumental gaps as
// `next.start - caption.end` and inserts a "♪" marker at caption.end + 0.5s when
// the gap is > 5s. Because end == start, EVERY segment spacing > 5s (a normal
// spaced lyric line) triggers a ♪ marker 0.5s into the CURRENT line — the lyric
// gets replaced by ♪ mid-vocal and the karaoke rushes forward through the music.
//
// GB checks FAIL against baseline ad29866 and must PASS after the fix.
// GP checks are regression guards and must stay PASS.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

const whisper = read(resolve(root, "src/lib/whisper.ts"));

if (!whisper) {
  fail("whisper.ts missing");
} else {
  // ---- GB1: no "end := timeInSeconds" anywhere in whisper.ts ------------------
  const badEndTis = /end:\s*line\.timeInSeconds/.test(whisper);
  if (!badEndTis) pass("GB1: whisper.ts no longer sets end := line.timeInSeconds");
  else fail("GB1: whisper.ts STILL sets end := line.timeInSeconds (seg.end dropped)");

  // ---- GB2: segmentsToResult SrtLine[] must carry a real end ------------------
  // The SrtLine[] built from the standardized LRC array must map end from the
  // segment's real end (either by mapping `useful` directly with seg.end, or by
  // carrying the end through lrcLines as {timeInSeconds, end, text}).
  const segResultBlock = whisper.slice(
    Math.max(whisper.indexOf("function segmentsToResult"), 0),
    whisper.indexOf("function groqTranscribe") > 0 ? whisper.indexOf("function groqTranscribe") : undefined,
  );
  const carriesRealEnd =
    /end:\s*seg\.end/.test(segResultBlock) ||
    /end:\s*useful\[i\]\.end/.test(segResultBlock) ||
    /\{\s*timeInSeconds:\s*seg\.start,\s*end:\s*seg\.end,\s*text:\s*seg\.text\s*\}/.test(segResultBlock) ||
    /timeInSeconds:\s*seg\.start,[\s\S]{0,120}?end:\s*seg\.end/.test(segResultBlock);
  const stillDropsEnd = /end:\s*line\.timeInSeconds/.test(segResultBlock);
  if (carriesRealEnd && !stillDropsEnd) pass("GB2: segmentsToResult SrtLine[] maps a real end (seg.end)");
  else fail(`GB2: segmentsToResult SrtLine[] end not fixed (carriesRealEnd=${carriesRealEnd}, stillDropsEnd=${stillDropsEnd})`);

  // ---- GB3: groqTranscribe SrtLine[] must carry a real end --------------------
  const groqBlock = whisper.slice(
    Math.max(whisper.indexOf("function groqTranscribe"), 0),
  );
  const groqUsesRealEnd = /end:\s*seg\.end/.test(groqBlock);
  const groqStillStart = /end:\s*seg\.start/.test(groqBlock);
  if (groqUsesRealEnd && !groqStillStart) pass("GB3: groqTranscribe SrtLine[] maps a real end (seg.end)");
  else fail(`GB3: groqTranscribe SrtLine[] end not fixed (groqUsesRealEnd=${groqUsesRealEnd}, groqStillStart=${groqStillStart})`);
}

// ---- GP4 (guard): buildLrc gap threshold unchanged (>5s, marker at end+0.5) ----
{
  const lyrics = read(resolve(root, "src/lib/lyrics.ts"));
  const threshold = /next\.start\s*-\s*caption\.end\s*>\s*5/.test(lyrics ?? "");
  const marker = /caption\.end\s*\+\s*0\.5/.test(lyrics ?? "");
  if (threshold && marker) pass("GP4: buildLrc gap rule intact (>5s, ♪ at end+0.5s)");
  else fail(`GP4: buildLrc gap rule changed (threshold=${threshold}, marker=${marker})`);
}

// ---- GP5 (guard): PlayerView karaoke driver untouched ------------------------
{
  const player = read(resolve(root, "src/components/PlayerView.tsx"));
  const timeupdate = (player ?? "").includes('addEventListener("timeupdate"');
  const findActive = /synced\[i\]\.time\s*<=\s*audio\.currentTime/.test(player ?? "");
  if (timeupdate && findActive) pass("GP5: PlayerView timeupdate→findActive sync intact");
  else fail(`GP5: PlayerView sync driver changed (timeupdate=${timeupdate}, findActive=${findActive})`);
}

console.log(`\n[verify-whisper-sync] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
