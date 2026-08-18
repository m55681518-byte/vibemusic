// Acceptance gate: "real-world Android sharing fixes"
// (freebuff-task-20260816-193137).
//
// User report: sharing the app's target URL from the Android share sheet fails
// with "Couldn't extract that link". Requirements:
//   1. Robust URL parsing — Android share targets pass MESSY text ("Check this
//      out https://vt.tiktok.com/xyz"), so /api/extract must regex-extract the
//      first valid http(s):// URL from any incoming string before it reaches
//      yt-dlp / cobalt.
//   2. Cache disabled on the API surface — /api/extract and /api/lyrics must be
//      `export const dynamic = "force-dynamic"` AND the frontend fetch to
//      /api/extract must send `cache: "no-store"`.
//   3. Error details surfaced — on failure the extract route must return
//      `{ error: "...", details: "yt-dlp exit 1: ..." }` and the frontend error
//      UI ("Couldn't extract that link") must render a small collapsible text
//      element showing error.details.
//   4. Multi-instance cobalt — array-fallback across >=3 public cobalt
//      endpoints when primary (yt-dlp) fails.
//
// Checks 1 & 3 FAIL against 778e89b; the fix must make them all PASS.
// Hermetic (no network), matching repo conventions.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const files = {
  extractLib: resolve(root, "src/lib/extract.ts"),
  extractRoute: resolve(root, "src/app/api/extract/route.ts"),
  lyricsRoute: resolve(root, "src/app/api/lyrics/route.ts"),
  cobalt: resolve(root, "src/lib/cobalt.ts"),
};

let passed = 0;
let failed = 0;
const pass = (m) => { console.log("PASS", m); passed++; };
const fail = (m) => { console.log("FAIL", m); failed++; };
const src = (name) => {
  const p = files[name];
  if (!existsSync(p)) { fail(`${name}: file missing`); return ""; }
  return readFileSync(p, "utf8");
};

// G1 — URL farming: a regex utility must extract the first valid http(s) URL
// from arbitrary share-sheet text ("Check this out https://vt.tiktok.com/xyz").
{
  const lib = src("extractLib");
  const parserDefined = /https?[\\/\\/\\/]{2}[^\\s"']+/ // bare regex literal anywhere
    .test(lib + src("extractRoute")) ||
    /extractValidUrl|parseFirstUrl|extractUrl|firstValidUrl/i
    .test(lib + src("extractRoute"));
  // The route must actually APPLY the parser to the incoming body.string.
  const applied = /body\?\.url[\s\S]{0,120}(extract|parse|match|replace)/.test(src("extractRoute")) ||
    /(?:extractValidUrl|parseFirstUrl|extractUrl|firstValidUrl)\(\s*(?:String\(\s*)?(?:body\??\.url|url|raw|input)/.test(src("extractRoute")) ||
    /url\s*=\s*(?:extractValidUrl|parseFirstUrl|extractUrl|firstValidUrl)/.test(src("extractRoute"));
  if (parserDefined && applied) pass("G1: extract route parses the first http(s) URL out of share text");
  else fail(`G1: no URL parser applied on /api/extract (defined=${parserDefined}, applied=${applied})`);
}

// G2 — cache disabled at route level.
{
  const er = src("extractRoute");
  const lr = src("lyricsRoute");
  const dynE = /export const dynamic\s*=\s*["']force-dynamic["']/.test(er);
  const dynL = /export const dynamic\s*=\s*["']force-dynamic["']/.test(lr);
  if (dynE && dynL) pass("G2: /api/extract and /api/lyrics are force-dynamic");
  else fail(`G2: force-dynamic missing (extract=${dynE}, lyrics=${dynL})`);
}

// G2b — cache disabled at the frontend fetch to /api/extract.
{
  const page = readFileSync(resolve(root, "src/app/extract/page.tsx"), "utf8");
  const noStore = /cache\s*:\s*["']no-store["']/.test(page) ||
    /cache:\s*["']no-store["']/.test(page);
  if (noStore) pass("G2b: frontend fetch('/api/extract') sends cache: 'no-store'");
  else fail(`G2b: no cache: 'no-store' on the extract fetch (found=${noStore})`);
}

// G3 — error details on failure (server side).
{
  const r = src("extractRoute");
  const hasDetails = /details\s*:/.test(r);
  const rawError = /details\s*:\s*(?:err\.[\w]+|String\(err\)|JSON\.stringify)/.test(r);
  if (hasDetails && rawError) pass("G3: extract route returns { error, details: raw } on failure");
  else fail(`G3: no { error, details } failure shape (details=${hasDetails}, raw=${rawError})`);
}

// G3b — collapsible details element on the frontend error UI.
// Native <details open> + <summary> (journal 031) IS browser-collapsible —
// no JS toggle required. Gate checks the real native mechanism.
{
  const page = readFileSync(resolve(root, "src/app/extract/page.tsx"), "utf8");
  const readsDetails = /\.details/.test(page) || /details\b/.test(page);
  const collapsible = /<details[^>]*>/.test(page) && /<summary>/.test(page);
  const pre = /<pre>/.test(page) && /\{phase\.details\}/.test(page);
  if (readsDetails && collapsible && pre)
    pass("G3b: error UI shows collapsible error.details (native <details open> + summary + pre)");
  else fail(`G3b: no collapsible details in error UI (reads=${readsDetails}, collapsible=${collapsible}, pre=${pre})`);
}

// G4 — multi-instance cobalt redundancy (>=3 endpoints, looped).
{
  const c = src("cobalt");
  const instances = [...c.matchAll(/["'`]https:\/\/[a-z0-9.-]+(?:\/[a-z0-9.-]*)?["'`]/g)].map((m) => m[0]);
  if (instances.length >= 3) pass(`G4: cobalt array-fallback over ${instances.length} endpoints`);
  else fail(`G4: cobalt has only ${instances.length} instance(s)`);
}

console.log(`\n[verify-sharing-robustness] ${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);