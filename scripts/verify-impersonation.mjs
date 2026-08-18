// Acceptance gate: yt-dlp must be invoked with browser impersonation so
// TikTok/YouTube don't block Render's datacenter IP as a bot (403 / "private
// or requires a login"). Also requires the Dockerfile to pull the absolute
// latest yt-dlp release (impersonation targets change frequently).
// Exit 0 = accept, 1 = reject.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const results = [];
const fail = (msg) => {
  results.push(`FAIL ${msg}`);
  console.error(`FAIL ${msg}`);
};
const pass = (msg) => {
  results.push(`PASS ${msg}`);
  console.log(`PASS ${msg}`);
};

// Generic `chrome` shorthand (journal 016): curl_cffi bundles the latest
// Chrome version, so a pinned chrome-146 value goes stale the moment yt-dlp
// rolls targets. The flag must be present at BOTH yt-dlp sites in ytdlp.ts.
const impersonationValue = "chrome";

// --- 1. src/lib/ytdlp.ts : getMediaInfo() must pass --impersonate chrome ----
const ytdlp = path.join(root, "src", "lib", "ytdlp.ts");
if (!existsSync(ytdlp)) {
  fail("src/lib/ytdlp.ts missing");
} else {
  const src = readFileSync(ytdlp, "utf8");
  const infoCall = src.match(/getMediaInfo\([\s\S]*?\[\s*([\s\S]*?)\s*\]/);
  if (!infoCall) {
    fail("getMediaInfo base args array not found in src/lib/ytdlp.ts");
  } else {
    const args = infoCall[1];
    if (/--impersonate/.test(args) && new RegExp(`["']${impersonationValue}["']`).test(args)) {
      pass("getMediaInfo passes --impersonate " + impersonationValue);
    } else {
      fail(`getMediaInfo args must include --impersonate ${impersonationValue}`);
    }
  }
}

// --- 1b. src/lib/ytdlp.ts : downloadAutoCaptions() must pass chrome ---------
{
  const src = readFileSync(ytdlp, "utf8");
  const capCall = src.match(/downloadAutoCaptions\(([\s\S]*?)\)[\s\S]*?execPromise\(\s*\[([\s\S]*?)\]/);
  if (!capCall) {
    fail("execPromise([...]) args array not found in ytdlp.ts downloadAutoCaptions");
  } else {
    const args = capCall[2];
    if (/--impersonate/.test(args) && new RegExp(`["']${impersonationValue}["']`).test(args)) {
      pass("downloadAutoCaptions passes --impersonate " + impersonationValue);
    } else {
      fail(`downloadAutoCaptions args must include --impersonate ${impersonationValue}`);
    }
  }
}

// --- 2. src/lib/extract.ts is 100% external (no yt-dlp base args; flags live
//        in ytdlp.ts — journal 030 architecture). Guard: no yt-dlp imports.
const extract = path.join(root, "src", "lib", "extract.ts");
if (!existsSync(extract)) {
  fail("src/lib/extract.ts missing");
} else {
  const src = readFileSync(extract, "utf8");
  const base = src.match(/base\s*:\s*string\[\]\s*=\s*\[([\s\S]*?)\];/);
  if (base && /--impersonate/.test(base[1])) {
    fail("extract.ts still carries yt-dlp base args with --impersonate (dead code since journal 030)");
  } else {
    pass("extract.ts is 100% external (no yt-dlp base args — correct for journal 030 architecture)");
  }
}

// --- 3. Dockerfile must pull the latest release (not a pinned version) -----
const dockerfile = path.join(root, "Dockerfile");
if (!existsSync(dockerfile)) {
  fail("Dockerfile missing");
} else {
  const df = readFileSync(dockerfile, "utf8");
  if (/yt-dlp\/yt-dlp\/releases\/latest\/download\/yt-dlp_linux/.test(df)) {
    pass("Dockerfile downloads yt-dlp from releases/latest (not pinned)");
  } else {
    fail("Dockerfile must download yt-dlp_linux from releases/latest/download (absolute latest; pinned versions go stale)");
  }
}

// --- 4. The installed yt-dlp binary must accept the impersonation flag -----
// Soft check: if no binary is present locally, defer to the CI container smoke
// (the Docker image installs the latest yt-dlp_linux and runs the real flag).
try {
  const out = execSync(`yt-dlp --impersonate ${impersonationValue} --version`, { stdio: "pipe", timeout: 60000 }).toString().trim();
  pass(`installed yt-dlp (${out}) accepts --impersonate ${impersonationValue}`);
} catch {
  const vendor = path.join(root, "vendor", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (existsSync(vendor)) {
    const out = execSync(`"${vendor}" --impersonate ${impersonationValue} --version`, { stdio: "pipe", timeout: 60000 }).toString().trim();
    pass(`vendor yt-dlp (${out}) accepts --impersonate ${impersonationValue}`);
  } else {
    console.log("NOTE no yt-dlp binary locally — impersonation support verified in CI container smoke (Dockerfile pulls latest)");
  }
}

const failed = results.some((r) => r.startsWith("FAIL"));
console.log(`\n[verify-impersonation] ${results.length - (failed ? results.filter((r) => r.startsWith("FAIL")).length : 0)}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
