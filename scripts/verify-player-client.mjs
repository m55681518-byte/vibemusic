// Acceptance gate: YouTube datacenter bot-wall bypass via player-client
// variants + browser impersonation, CURRENT architecture (journal 016/030):
//   - extract.ts is 100% external (TikWM/cobalt) — NO yt-dlp args there.
//   - src/lib/ytdlp.ts is the ONLY yt-dlp runner; PLAYER_CLIENT_VARIANTS
//     tries `default,-android_sdkless` first, then `tv` (the YouTube-on-TV
//     embedded player is generally NOT blocked on server IPs).
//   - Both invocation sites (getMediaInfo, downloadAutoCaptions) pass
//     --impersonate chrome (generic shorthand — curl_cffi bundles latest).
// Exit 0 = accept, 1 = reject.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };

const ytdlpPath = resolve(root, "src/lib/ytdlp.ts");
const extractPath = resolve(root, "src/lib/extract.ts");
if (!existsSync(ytdlpPath)) {
  fail("src/lib/ytdlp.ts missing");
} else {
  const src = readFileSync(ytdlpPath, "utf8");

  if (/player_client=default,-android_sdkless/.test(src))
    pass("ytdlp.ts PLAYER_CLIENT_VARIANTS tries default,-android_sdkless first");
  else fail("ytdlp.ts missing player_client=default,-android_sdkless variant");

  if (/player_client=tv/.test(src))
    pass("ytdlp.ts has tv client failover variant");
  else fail("ytdlp.ts missing player_client=tv failover variant");

  if (/getMediaInfo[\s\S]{0,600}--impersonate[\s\S]{0,60}["']chrome["']/.test(src))
    pass("getMediaInfo passes --impersonate chrome");
  else fail("getMediaInfo missing --impersonate chrome");

  if (/downloadAutoCaptions[\s\S]{0,1200}--impersonate[\s\S]{0,60}["']chrome["']/.test(src))
    pass("downloadAutoCaptions passes --impersonate chrome");
  else fail("downloadAutoCaptions missing --impersonate chrome");
}

if (!existsSync(extractPath)) {
  fail("src/lib/extract.ts missing");
} else {
  // Strip comments first — extract.ts documents the pre-rewrite yt-dlp path
  // in a legacy note (journal 030 retrospect); only CODE matters for the guard.
  const extract = readFileSync(extractPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  if (/--impersonate|player_client/.test(extract))
    fail("extract.ts should NOT carry yt-dlp impersonate/player_client args (100% external since journal 030)");
  else pass("extract.ts has no yt-dlp impersonate/player_client args in code (external path correct)");
}

console.log(`\n[verify-player-client] ${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
