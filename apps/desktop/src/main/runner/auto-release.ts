import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Actor, AutoReleaseRecord, DesktopProject, HiveBackend, ReleaseStep } from "@xdev-hive/core";
import { killTree } from "#desktop/main/runner/kill.ts";

const exec = promisify(execFile);
export interface ReleaseHost {
  backend(): HiveBackend;
  actor(): Actor;
  projects(): DesktopProject[];
  env(): NodeJS.ProcessEnv;
  allowed(project?: string): boolean;
}
export interface ReleaseResult { success: boolean; step: ReleaseStep; warning: boolean }

/** Project commands own version/roadmap preparation and release notes (59h); secrets stay in this process. */
export async function executeRelease(job: AutoReleaseRecord, project: DesktopProject, run: (argv: string[], env: NodeJS.ProcessEnv) => Promise<void>, rollout: () => Promise<void>, progress: (step: ReleaseStep) => Promise<void> = async () => {}): Promise<ReleaseResult> {
  let step: ReleaseStep = "prepare";
  const commands = project.autoRelease;
  const env = { HIVE_RELEASE_VERSION: job.batch.version, HIVE_RELEASE_SHA: job.batch.sha, HIVE_RELEASE_BATCH: job.batchId, HIVE_RELEASE_TASKS_JSON: JSON.stringify(job.batch.taskIds) };
  try {
    if (!commands) throw new Error("No local release configuration");
    await progress(step); await run(commands.prepare, env);
    step = "release"; await progress(step); await run(commands.release, env);
    if (commands.deploy) { step = "deploy"; await progress(step); await run(commands.deploy, env); }
    if (commands.appRollout) { step = "rollout"; await progress(step); await rollout(); }
    if (commands.checkLogs) {
      step = "checkLogs"; await progress(step);
      try { await run(commands.checkLogs, env); }
      catch { return { success: true, step, warning: true }; }
    }
    return { success: true, step, warning: false };
  } catch { return { success: false, step, warning: false }; }
}

export class AutoReleaseWorker {
  #inflight: Promise<void> | null = null;
  #polling = false;
  #stopped = false;
  #cancel: (() => void) | null = null;
  private host: ReleaseHost;
  private dir: string;
  constructor(host: ReleaseHost, dir: string) { this.host = host; this.dir = dir; }
  get busy() { return this.#polling || !!this.#inflight; }
  stop() { this.#stopped = true; this.#cancel?.(); }
  async settle() { while (this.#polling) await new Promise(r => setTimeout(r, 10)); await this.#inflight; }
  async poll() {
    if (this.busy || this.#stopped || !this.host.allowed()) return;
    this.#polling = true;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // Persist the receipt before reporting: losing the reply retries only the result, never a release command.
      for (const name of readdirSync(this.dir).filter(n => n.endsWith(".json"))) {
        const file = path.join(this.dir, name);
        await this.host.backend().call("autoRelease.result", JSON.parse(readFileSync(file, "utf8")), this.host.actor());
        rmSync(file);
      }
      for (const project of this.host.projects().filter(p => p.autoRelease && this.host.allowed(p.name))) {
        let job: AutoReleaseRecord | null;
        try { job = await this.host.backend().call("autoRelease.take", { project: project.name }, this.host.actor()); }
        catch { continue; }
        if (!job) continue;
        this.#inflight = this.#execute(job, project).finally(() => { this.#inflight = null; this.#cancel = null; });
        // Reporting a lost response is retried from the receipt on the next heartbeat.
        void this.#inflight.catch(() => undefined);
        break;
      }
    } finally { this.#polling = false; }
  }
  async #execute(job: AutoReleaseRecord, project: DesktopProject) {
    const key = createHash("sha256").update(`${job.project}/${job.batchId}`).digest("hex");
    let result: ReleaseResult = { success: false, step: "prepare", warning: false };
    try {
      // Merge batches land from a disposable checkout; release must not rewrite the user's checkout to that SHA.
      const checkout = path.join(this.dir, `${key}-checkout`);
      const gitAt = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, timeout: 120_000, env: this.host.env() })).stdout.trim();
      if (existsSync(checkout)) throw new Error("Release checkout already exists; reconcile before retrying.");
      await gitAt(project.repo, "clone", "--no-hardlinks", "--no-checkout", "--", project.repo, checkout);
      let remote: string | null = null;
      try { remote = await gitAt(project.repo, "remote", "get-url", "origin"); } catch { /* Local fixture repositories have no remote. */ }
      if (remote) {
        await gitAt(checkout, "remote", "set-url", "origin", remote);
        try { await gitAt(checkout, "cat-file", "-e", `${job.batch.sha}^{commit}`); }
        catch { await gitAt(checkout, "fetch", "--no-tags", "origin", job.batch.sha); }
      }
      const targetBranch = job.batch.targetBranch ?? project.targetBranch ?? "main";
      await gitAt(checkout, "checkout", "-B", targetBranch, job.batch.sha);
      project = { ...project, repo: checkout };
      const git = (...args: string[]) => gitAt(checkout, ...args);
      if (this.#stopped || await git("status", "--porcelain") || await git("rev-parse", "HEAD") !== job.batch.sha || await git("branch", "--show-current") !== targetBranch) throw new Error("Checkout changed since green batch");
      result = await executeRelease(job, project, (argv, env) => this.#command(argv, project, env, key), async () => { await this.host.backend().call("autoRelease.rollout", { project: job.project, batchId: job.batchId }, this.host.actor()); }, async step => { await this.host.backend().call("autoRelease.progress", { project: job.project, batchId: job.batchId, step }, this.host.actor()); });
    } catch { /* Only the failed stage goes to the hub; local output may contain secrets. */ }
    const receipt = { project: job.project, batchId: job.batchId, ...result };
    const file = path.join(this.dir, `${key}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    await this.host.backend().call("autoRelease.result", receipt, this.host.actor());
    rmSync(file);
  }
  #command(argv: string[], project: DesktopProject, env: NodeJS.ProcessEnv, key: string): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error("Stopped"));
    return new Promise((resolve, reject) => {
      const fd = openSync(path.join(this.dir, `${key}.log`), "a", 0o600);
      const child = spawn(argv[0]!, argv.slice(1), { cwd: project.repo, env: { ...this.host.env(), ...env }, detached: process.platform !== "win32", stdio: ["ignore", fd, fd] });
      closeSync(fd);
      let cancelled = false;
      this.#cancel = () => { cancelled = true; killTree(child); };
      const timer = setTimeout(() => this.#cancel?.(), project.autoRelease!.timeoutMinutes * 60_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Release command failed")); });
      child.once("close", code => { clearTimeout(timer); this.#cancel = null; code === 0 && !cancelled ? resolve() : reject(new Error("Release command failed")); });
    });
  }
}
