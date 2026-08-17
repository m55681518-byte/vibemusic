import { readFileSync } from "node:fs";
const t = readFileSync("src/lib/lyrics.ts", "utf8");
const i = t.indexOf("export function buildLrc");
const j = t.indexOf("async function getJson");
const src = t
  .slice(i, j)
  .replace("export function buildLrc", "function buildLrc")
  .replace("(captions: SrtLine[]): string {", "(captions) {");
const wrapped = "globalThis.buildLrc = " + src.slice(src.indexOf("function buildLrc"));
eval(wrapped);
const buildLrc = globalThis.buildLrc;
const lrc = buildLrc([
  { start: 1, end: 6, text: "line one" },
  { start: 14, end: 18, text: "line two" },
]);
console.log(lrc);
const ok = lrc.includes("[00:06.500] ♪") && !lrc.includes("[00:01.500]");
console.log(ok ? "SANITY PASS" : "SANITY FAIL");
process.exit(ok ? 0 : 1);