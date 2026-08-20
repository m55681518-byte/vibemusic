#!/usr/bin/env node
/**
 * verify-pot-provider.mjs — acceptance gate for the "YouTube PO-token provider"
 * fix (freebuff-task-20260821-013543).
 *
 * WHY: Render's datacenter IP is hard-blocked by YouTube ("Sign in to confirm
 * you're not a bot") for ALL yt-dlp player clients (default/tv/android_vr —
 * verified live 2026-08-21). The standard open-source remedy is the
 * bgutil-ytdlp-pot-provider: a POT-generation HTTP server + a yt-dlp plugin.
 * This gate pins the container wiring for it.
 *
 * All checks are static (Dockerfile / start script content).
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

let failures = 0;
let checks = 0;
const check = (name, ok, detail = "") => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");

// The start script may be start.sh or embedded in the Dockerfile CMD — accept
// either but SOMETHING must launch both processes.
const startShPath = path.join(root, "start.sh");
const startSh = existsSync(startShPath) ? readFileSync(startShPath, "utf8") : "";

// G1 — runner stage installs the bgutil POT provider server (clone + deps + build).
check(
  "G1 Dockerfile builds bgutil-ytdlp-pot-provider server",
  dockerfile.includes("bgutil-ytdlp-pot-provider") &&
    /npm (ci|install)/.test(dockerfile),
  "clone/install of the POT server missing",
);

// G2 — the yt-dlp plugin is installed into a system plugin dir so the
// standalone yt-dlp binary loads it (/etc/yt-dlp/plugins).
check(
  "G2 yt-dlp plugin installed into /etc/yt-dlp/plugins",
  /\/etc\/yt-dlp\/plugins/.test(dockerfile),
  "plugin copy into /etc/yt-dlp/plugins missing",
);

// G3 — the container runs BOTH the POT server (port 4416 default) and next
// start; the server must be up before/while the app serves.
const combined = startSh + "\n" + dockerfile;
check(
  "G3 container starts POT server alongside next start",
  /main\.js/.test(combined) &&
    (/start\.sh/.test(dockerfile) ? /next start|next-server/.test(combined) : true) &&
    /next start|"next", "start"|node_modules\/\.bin\/next/.test(combined),
  "dual-process startup missing",
);

// G4 — the start script is executable in the image (chmod +x) or CMD invokes
// it via sh so no exec bit is needed.
check(
  "G4 startup is wired into the image CMD",
  /CMD.*(start\.sh|next)/.test(dockerfile.replace(/\n/g, " ")) &&
    (/start\.sh/.test(dockerfile) ? /chmod \+x .*start\.sh|sh .*start\.sh|bash .*start\.sh/.test(dockerfile) : true),
  "CMD does not reference the startup path",
);

// G5 — yt-dlp binary path env stays intact (the app execs $YTDLP_PATH).
check(
  "G5 YTDLP_PATH still exported",
  dockerfile.includes("ENV YTDLP_PATH=/usr/local/bin/yt-dlp"),
  "YTDLP_PATH env missing",
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} gate check(s) FAILED — see above`);
  process.exit(1);
}