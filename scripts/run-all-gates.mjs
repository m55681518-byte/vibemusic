// One-shot gate sweep runner: spawns every verify-*.mjs gate, collects the
// summary line + exit code. Usage: node scripts/run-all-gates.mjs > sweep.txt
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname);
const gates = readdirSync(dir).filter((f) => /^verify-.+\.mjs$/.test(f)).sort();
let passed = 0;
let failed = 0;
for (const g of gates) {
  let out = "";
  let code = -1;
  try {
    out = execFileSync(process.execPath, [resolve(dir, g)], { timeout: 120_000, encoding: "utf8" });
    code = 0;
  } catch (e) {
    out = e.stdout ?? "";
    code = e.status ?? -1;
  }
  const summary = out.split(/\r?\n/).filter((l) => l.includes("checks passed")).pop() ?? "(no summary)";
  const ok = code === 0;
  if (ok) passed++; else failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${g} -> ${summary.trim()} (exit ${code})`);
}
console.log(`\nSWEEP: ${passed}/${passed + failed} gates passed`);
process.exit(failed ? 1 : 0);
