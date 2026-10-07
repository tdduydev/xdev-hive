// Checks that every e2e step runs green alone: for each step, `run.mjs --only <step>` on a fresh hub (so only what NEEDS names runs before it).
//   node e2e/check-needs.mjs [--steps a,b] [--mobile] [--probe '{"step":["dep"]}']
// Prints the steps that do not run alone and exits 1 when there are any. --probe tries another NEEDS table through HIVE_E2E_NEEDS
// (a step missing from it needs nothing) so a smaller table can be proven before it goes into browser.mjs.
// Linux without a display: run it under xvfb-run.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const mobile = args.includes("--mobile");
const probe = flag("--probe");
const source = readFileSync(path.join(import.meta.dirname, "browser.mjs"), "utf8");
// Same pattern as browser.mjs: a nested step is listed too, and runs with its parent.
const all = [...source.matchAll(/^\s*(?:if \(mobile\) )?await step\("([^"]+)"/gm)].map((m) => m[1]);
const steps = flag("--steps")?.split(",") ?? all;
const out = mkdtempSync(path.join(os.tmpdir(), "hive-needs-"));
const env = { ...process.env };
if (mobile) Object.assign(env, { HIVE_E2E_W: "390", HIVE_E2E_H: "844" });
if (probe) {
  const table = JSON.parse(probe);
  env.HIVE_E2E_NEEDS = JSON.stringify(Object.fromEntries(all.map((s) => [s, table[s] ?? []])));
}

const broken = [];
for (const name of steps) {
  const dir = path.join(out, name);
  const ran = spawnSync(process.execPath, [path.join(import.meta.dirname, "run.mjs"), dir, "--no-build", "--only", name], { env, encoding: "utf8" });
  let result;
  try { result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")).results.find((r) => r.name === name); } catch { /* no result: the run died */ }
  // A mobile-only step is skipped on the desktop size: nothing ran, nothing to prove.
  if (!result && !mobile && source.includes(`if (mobile) await step("${name}"`)) { console.log(`- ${name}: mobile only (use --mobile)`); continue; }
  const ok = result?.ok === true;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `: ${result?.error ?? (ran.stderr || ran.stdout).split("\n").slice(-6).join(" | ")}`}`);
  if (!ok) broken.push(name);
}
console.log(broken.length ? `\nsteps that do not run alone (${broken.length}): ${broken.join(", ")}` : `\nall ${steps.length} steps run alone`);
process.exit(broken.length ? 1 : 0);
