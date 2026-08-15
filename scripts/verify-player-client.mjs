// Acceptance gate for Turn B: youtube:player_client=android bypass for datacenter bot wall.
// Checks (hard):
//  1. src/lib/extract.ts base args include --extractor-args "youtube:player_client=android"
//  2. src/lib/ytdlp.ts getVideoInfo args include --extractor-args "youtube:player_client=android"
//  3. Both still pass --impersonate chrome-146 (regression guard)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const extract = resolve(root, "src/lib/extract.ts");
const ytdlp = resolve(root, "src/lib/ytdlp.ts");

let passed = 0;
let failed = 0;
const pass = (msg) => { console.log("PASS", msg); passed++; };
const fail = (msg) => { console.log("FAIL", msg); failed++; };

function existsSafe(p) {
  try { readFileSync(p); return true; } catch { return false; }
}

const needPlayerClient = /player_client=android/;
const needImpersonate = /--impersonate/;
const needChrome146 = /chrome-146/;

if (existsSafe(extract)) {
  const src = readFileSync(extract, "utf8");
  if (needPlayerClient.test(src)) pass("extract.ts passes youtube:player_client=android");
  else fail("extract.ts missing youtube:player_client=android");
  if (needImpersonate.test(src) && needChrome146.test(src)) pass("extract.ts still passes --impersonate chrome-146");
  else fail("extract.ts lost --impersonate chrome-146");
} else {
  fail("src/lib/extract.ts missing");
}

if (existsSafe(ytdlp)) {
  const src = readFileSync(ytdlp, "utf8");
  if (needPlayerClient.test(src)) pass("ytdlp.ts passes youtube:player_client=android");
  else fail("ytdlp.ts missing youtube:player_client=android");
  if (needImpersonate.test(src) && needChrome146.test(src)) pass("ytdlp.ts still passes --impersonate chrome-146");
  else fail("ytdlp.ts lost --impersonate chrome-146");
} else {
  fail("src/lib/ytdlp.ts missing");
}

console.log(`\n[verify-player-client] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
