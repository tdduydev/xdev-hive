// Runs gate jobs for real on this machine (69h2, AC09): the app's own GateExecutor, the templates of a local policy
// file, a repo on disk and a throwaway in-memory hub that approves each job as a person would. The commands are the
// real ones (desktop smoke, web e2e…) in a fresh clone of the SHA; nothing is faked but the hub and the approval.
//   node apps/desktop/scripts/gate-evidence.mjs <policy.json> <repo> <out dir> <template>:<ref>[:<sha>] …
// The policy is the gate-jobs.json format (0600, this user). The repo is read by its local refs when it has no origin.
// Writes <out dir>/report.json (jobs with receipts) and the files each job uploaded, under <out dir>/<job id>/.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { SqliteHive, gateTemplateHash } from "@xdev-hive/core/node";
import { ResourceLocks } from "../src/main/resource-locks.ts";
import { GateExecutor, readGatePolicy } from "../src/main/runner/gate.ts";

const [policyFile, repo, outArg, ...jobs] = process.argv.slice(2);
if (!policyFile || !repo || !outArg || !jobs.length) { console.error("usage: gate-evidence.mjs <policy.json> <repo> <out dir> <template>:<ref>[:<sha>] …"); process.exit(2); }
const out = path.resolve(outArg);
mkdirSync(out, { recursive: true });
const policy = readGatePolicy(policyFile, new Set());
const project = Object.keys(policy.projects)[0];
const data = mkdtempSync(path.join(os.tmpdir(), "hive-gate-evidence-"));
copyFileSync(policyFile, path.join(data, "gate-jobs.json"));
const person = { name: "evidence", role: "member", account: "evidence", humanSession: "evidence", access: { projects: { [project]: "manage" } } };
const machine = { name: `runner.${os.hostname().split(".")[0].toLowerCase()}@evidence`, role: "agent", account: "evidence" };
const hub = new SqliteHive(":memory:", { gateJobs: true });
const executor = new GateExecutor({
  backend: () => hub, actor: () => machine, projects: () => [{ name: project, repo: path.resolve(repo) }],
  // The app passes its login-shell env; here the shell's own, minus what the gate must never see anyway.
  env: () => process.env, allowed: () => true, locks: new ResourceLocks(), secretEnv: () => [], known: () => [],
  version: "evidence", log: (line) => console.log(`[gate] ${line}`),
}, data);

const report = [];
try {
  for (const spec of jobs) {
    const [templateId, ref, given] = spec.split(":");
    const template = policy.projects[project].templates.find((t) => t.id === templateId);
    if (!template) throw new Error(`no template ${templateId}`);
    const sha = given ?? execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd: repo, encoding: "utf8" }).trim();
    const reply = await hub.call("machines.heartbeat", { machine: "evidence", instance: "aabbccdd", projects: [project], gate: executor.capability() }, machine);
    executor.onHub(reply.gate);
    const job = await hub.call("gate.create", { project, machineId: machine.name, templateId, templateHash: gateTemplateHash(template), sha, ref, purpose: "evidence", idempotencyKey: spec }, person);
    await hub.call("gate.approve", { id: job.id, version: job.version, pass: true, reason: "AC09 evidence" }, person);
    console.log(`[gate] ${job.id}: ${templateId} on ${ref} @ ${sha.slice(0, 12)}`);
    const started = Date.now();
    await executor.poll();
    await executor.settle();
    const done = await hub.call("gate.get", { id: job.id }, person);
    const files = await hub.call("artifacts.list", { project, runId: job.id }, person);
    for (const f of files) {
      const file = path.join(out, job.id, f.name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from((await hub.call("artifacts.get", { id: f.id }, person)).data, "base64"));
    }
    report.push({ spec, seconds: Math.round((Date.now() - started) / 1000), job: done, uploaded: files.map((f) => ({ name: f.name, sha256: f.sha256, size: f.size })) });
    console.log(`[gate] ${job.id}: ${done.state}${done.reason ? ` (${done.reason})` : ""} in ${Math.round((Date.now() - started) / 1000)} s`);
    writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  }
} finally {
  hub.close();
  // Logs and clones stay for whoever checks the receipts: the log never leaves the machine (spec 69h1 §8).
  console.log(`[gate] local logs: ${path.join(data, "gate")}`);
}
