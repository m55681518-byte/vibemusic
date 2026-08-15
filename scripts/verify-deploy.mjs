// Verify-deploy acceptance test (Guardian step 2 pre-write gate).
// Hard requirements (must PASS before deploy is accepted):
//   1. Dockerfile exists and installs BOTH yt-dlp and ffmpeg for Linux.
//   2. render.yaml OR railway.json exists and is structurally valid.
//   3. The Next.js app builds cleanly for production (next build).
// Optional: if Docker is available, build the image and smoke test it.
// Exit code 0 = accept, 1 = reject. Prints one line per check.
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

console.log(`[verify-deploy] root=${root}`);

const dockerfile = path.join(root, "Dockerfile");
if (!existsSync(dockerfile)) {
  fail("Dockerfile missing");
} else {
  const df = readFileSync(dockerfile, "utf8");
  const lower = df.toLowerCase();
  if (/install\s+.*ffmpeg|apt-get install ffmpeg|apk add.*ffmpeg|yum install.*ffmpeg/.test(lower)) {
    pass("Dockerfile installs ffmpeg");
  } else {
    fail("Dockerfile does not install ffmpeg (look for apt-get/apk/yum install ffmpeg)");
  }
  if (/yt-dlp/.test(df)) {
    pass("Dockerfile references yt-dlp");
  } else {
    fail("Dockerfile does not reference yt-dlp");
  }
  if (/\bfrom\s+node:\d+\b/i.test(df) || /linux/i.test(df)) {
    pass("Dockerfile is a Linux/Node base image");
  } else {
    fail("Dockerfile does not use a Node/Linux base image");
  }
  if (!/(\.next|standalone|next start|next build|npm run build)/i.test(df)) {
    fail("Dockerfile does not build/run the Next.js app (.next, next start, npm run build)");
  } else {
    pass("Dockerfile builds/runs the Next.js app");
  }
}

const renderYaml = path.join(root, "render.yaml");
const railwayJson = path.join(root, "railway.json");
if (existsSync(renderYaml)) {
  pass("render.yaml present");
  if (/docker|Dockerfile/.test(readFileSync(renderYaml, "utf8"))) {
    pass("render.yaml points at the Docker build");
  } else {
    fail("render.yaml does not reference a Docker build");
  }
} else {
  fail("render.yaml missing (deployment config required)");
}
if (existsSync(railwayJson)) {
  pass("railway.json present");
  try {
    JSON.parse(readFileSync(railwayJson, "utf8"));
    pass("railway.json is valid JSON");
  } catch (e) {
    fail(`railway.json invalid JSON: ${e.message}`);
  }
}

if (!existsSync(path.join(root, ".dockerignore"))) {
  fail(".dockerignore missing (needed to keep node_modules/.next out of build context)");
} else {
  pass(".dockerignore present");
}

try {
  const out = execSync("npm run build", { cwd: root, stdio: "pipe", timeout: 300000 });
  pass("npm run build succeeded");
  process.stdout.write(String(out));
} catch (e) {
  fail(`npm run build FAILED: ${String(e.stderr || e.message).split("\n").slice(-15).join("\n")}`);
}

let dockerAvailable = false;
try {
  execSync("docker version --format '{{.Server.Version}}'", { stdio: "pipe", timeout: 15000 });
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

if (dockerAvailable) {
  console.log("[verify-deploy] docker available - running container smoke");
  try {
    execSync("docker build -t vibemusic:verify .", { cwd: root, stdio: "inherit", timeout: 600000 });
    const runOut = execSync(
      'docker run --rm -d --name vibemusic-verify -p 3100:3000 vibemusic:verify',
      { cwd: root, timeout: 60000 },
    ).toString();
    try {
      execSync(
        'docker exec vibemusic-verify sh -c "yt-dlp --version && ffmpeg -version"',
        { stdio: "pipe", timeout: 60000 },
      );
      pass("container has yt-dlp + ffmpeg");
      execSync("curl -fsS http://localhost:3100/ >/dev/null", { timeout: 60000 });
      pass("container serves HTTP 200 on /");
    } finally {
      execSync("docker rm -f vibemusic-verify", { stdio: "ignore", timeout: 30000 });
    }
  } catch (e) {
    fail(`container smoke FAILED: ${String(e.message).split("\n").slice(-10).join("\n")}`);
  }
} else {
  console.log("[verify-deploy] docker not available - container smoke skipped (runs in CI)");
}

const failed = results.some((r) => r.startsWith("FAIL"));
console.log(`\n[verify-deploy] ${results.length - (failed ? results.filter((r) => r.startsWith("FAIL")).length : 0)}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
