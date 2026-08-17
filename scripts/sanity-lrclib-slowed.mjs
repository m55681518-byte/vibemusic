import { readFileSync } from "node:fs";
const t = readFileSync("src/lib/lyrics.ts", "utf8");

const stripTypes = (body) => body
  .replace(/^export\s+/, "")
  .replace(/function maxLrcTimestamp\(lrc: string\): number/, "function maxLrcTimestamp(lrc)")
  .replace(/function rescaleLrc\(lrc: string, ratio: number\): string/, "function rescaleLrc(lrc, ratio)");

const extractAssign = (name) => {
  const i = t.indexOf("function " + name);
  const open = t.indexOf("{", i) + 1;
  let d = 1, j = open - 1;
  for (;;) { j++; if (t[j] === "{") d++; else if (t[j] === "}") { d--; if (d === 0) break; } }
  const body = stripTypes(t.slice(i, j + 1));
  const fn = body.replace(/^function\s+\w+\s*/, "function ");
  return "globalThis." + name + " = " + fn;
};

const tag = t.match(/const LRC_TIME_TAG\s*=\s*\/[^\n]*\/[dgimsuvy]*\s*;/)[0].replace("const ", "globalThis.");
eval(tag);
eval(extractAssign("maxLrcTimestamp"));
eval(extractAssign("rescaleLrc"));

const actual = 94.632;
const toLrc = (seconds) => {
  const totalMs = Math.round(seconds * 1000);
  const mm = Math.floor(totalMs / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}]`;
};
const buildLrc = (times) => times.map((x) => `${toLrc(x)} x`).join("\n");
const readTimes = (lrc) => [...lrc.matchAll(/\[(\d+):(\d\d)\.(\d\d\d)\]/g)]
  .map((m) => Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000);

const plain84Lrc = buildLrc([0.14, 2.57, 5.58, 9.85, 11.66, 14.16, 80.26]);

const span = globalThis.maxLrcTimestamp(plain84Lrc);
console.log("SPAN of served LRC:", span.toFixed(2), "(expected ~80.26)");
const ratio = actual / span;
console.log("RATIO (span-based):", ratio.toFixed(4), "(vs old record-dur ratio 0.9961 that skipped rescale)");
console.log("rescale triggers:", Math.abs(ratio - 1) > 0.02);

const scaled = globalThis.rescaleLrc(plain84Lrc, ratio);
const times = readTimes(scaled);
console.log("SCALED first:", times[0].toFixed(3), "s (was 0.14)", "| last:", times[times.length - 1].toFixed(2), "s (was 80.26)");
console.log("end-to-end alignment to 94.6s audio:", Math.abs(times[times.length - 1] - actual) < 1.0);

const slowedLrc = buildLrc([0.17, 3.25, 6.24, 10.61, 12.95, 16.51, 89.96]);
const slowedSpan = globalThis.maxLrcTimestamp(slowedLrc);
const slowedRatio = actual / slowedSpan;
console.log("Slowed-hit span:", slowedSpan.toFixed(2), "ratio:", slowedRatio.toFixed(4), "rescale triggers:", Math.abs(slowedRatio - 1) > 0.02, "(already aligned, ok)");

const ok = span > 79 && Math.abs(ratio - 1) > 0.02 && times[0] > 0.15 && times[0] < 0.18 && Math.abs(times[times.length - 1] - actual) < 1.0;
console.log(ok ? "SANITY PASS" : "SANITY FAIL");
process.exit(ok ? 0 : 1);