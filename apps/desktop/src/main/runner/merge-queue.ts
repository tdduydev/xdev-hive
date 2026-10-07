import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { collectArtifacts } from "#desktop/main/runner/artifacts.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { redactLines, validMergeRef } from "@xdev-hive/core";
import type { MergeBatch, MergeResult, HiveBackend, Actor, DesktopProject } from "@xdev-hive/core";
const exec = promisify(execFile);
const missingRemote = (branch: string, remote: string) => `Branch ${branch} is not on remote ${remote} (nhánh chưa có trên remote ${remote}).`;
const errorText = (e: unknown) => redactLines(String((e as {
  stderr?: string;
}).stderr || (e as Error).message || e)).slice(-16000);
const isMissingRemoteRef = (e: unknown, branch: string) => {
  const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`couldn't find remote ref\\s+(?:refs/heads/)?${escaped}(?:\\s|$)`, "i").test(errorText(e));
};
export interface GateOptions {
  repo: string;
  directory: string;
  env?: NodeJS.ProcessEnv;
  remote?: string;
  progress(step: string, log: string): Promise<void>;
  openMr?: (branch: string) => Promise<string>;
  /** Tests supply publication without touching any remote. */
  publish?: (sha: string, target: string) => Promise<void>;
  local?: boolean;
  signal?: AbortSignal;
  releaseVersion?: (sha: string) => Promise<string>;
}

/** Each batch owns a disposable worktree and a journal outside it, so a restart cannot publish unchecked code. */
export async function runMergeBatch(batch: MergeBatch, opts: GateOptions): Promise<MergeResult> {
  mkdirSync(opts.directory, {
    recursive: true
  });
  const journal = path.join(opts.directory, "result.json");
  const worktree = path.join(opts.directory, "worktree");
  const identity = createHash("sha256").update(`${batch.machineId}:${batch.createdAt}`).digest("hex").slice(0, 10);
  const branch = `review/hive-${batch.id}-${identity}`;
  const remote = opts.remote ?? "origin";
  const env = {
    ...process.env,
    ...opts.env,
    GIT_TERMINAL_PROMPT: "0"
  };
  const git = async (cwd: string, args: string[]) => (await exec("git", ["-c", `core.hooksPath=${os.devNull}`, ...args], {
    cwd,
    // isMissingRemoteRef matches Git's English message; a translated one would silently skip the push.
    env: { ...env, LC_ALL: "C", LANGUAGE: "C" },
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    signal: opts.signal
  })).stdout.trim();
  const save = (result: MergeResult, phase: string) => {
    writeFileSync(`${journal}.tmp`, JSON.stringify({
      phase,
      result
    }));
    renameSync(`${journal}.tmp`, journal);
  };
  let result: MergeResult = {
    status: "failed",
    sha: null,
    url: null,
    step: "prepare",
    log: "",
    outcomes: batch.items.map(i => ({
      taskId: i.taskId,
      status: "included",
      reason: ""
    }))
  };
  const progress = async (step: string, log = "") => {
    result.step = step.slice(0, 300);
    result.log = redactLines(`${result.log}\n${log}`).slice(-32000);
    await opts.progress(result.step, result.log);
  };
  const refreshTarget = async () => {
    if (opts.local) return git(opts.repo, ["rev-parse", `refs/heads/${batch.config.target}^{commit}`]);
    await git(opts.repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${batch.config.target}:refs/hive-merge/${batch.id}/target`]);
    return git(opts.repo, ["rev-parse", `refs/hive-merge/${batch.id}/target^{commit}`]);
  };
  const landed = async (sha: string) => {
    const target = await refreshTarget();
    try {
      await git(opts.repo, ["merge-base", "--is-ancestor", sha, target]);
      return true;
    } catch {
      return false;
    }
  };
  if (existsSync(journal)) {
    const saved = JSON.parse(readFileSync(journal, "utf8")) as {
      phase: string;
      result: MergeResult;
    };
    result = saved.result;
    if (saved.phase === "complete") return result;
    // A lost publish response may mean it landed. Verify before deciding whether any retry is safe.
    if (result.sha && (await landed(result.sha))) {
      result.status = "landed";
      result.step = "landed";
      save(result, "complete");
      return result;
    }
    if (saved.phase === "awaiting") return result;
    if (saved.phase === "publishing" && batch.config.mode === "mr" && opts.openMr) {
      if (await git(opts.repo, ["rev-parse", `refs/heads/${branch}^{commit}`]) !== result.sha) {
        result.status = "failed";
        result.step = "recovery";
        result.log = `${result.log}\nBatch branch changed after its gate checks.`.slice(-32000);
        save(result, "complete");
        return result;
      }
      await progress("publish");
      result.url = await opts.openMr(branch);
      result.status = "awaiting";
      result.step = "awaiting";
      save(result, "awaiting");
      return result;
    }
    result.status = "failed";
    result.step = "recovery";
    result.log = `${result.log}\nInterrupted batch; target does not contain its checked commit. Inspect before retrying.`.slice(-32000);
    save(result, "complete");
    return result;
  }
  save(result, "preparing");
  try {
    if (!validMergeRef(batch.config.target)) throw new Error("Invalid Git ref.");
    if (!batch.config.commands.length) throw new Error("No gate commands configured.");
    const base = await refreshTarget();
    await git(opts.repo, ["worktree", "add", "-b", branch, worktree, base]);
    for (let n = 0; n < batch.items.length; n++) {
      const item = batch.items[n]!;
      const outcome = result.outcomes[n]!;
      await progress(`merge: ${item.taskId}`);
      const before = await git(worktree, ["rev-parse", "HEAD"]);
      try {
        if (!validMergeRef(item.branch)) throw new Error("Invalid source branch.");
        let ref = `refs/heads/${item.branch}`;
        if (!opts.local) {
          try {
            ref = `refs/hive-merge/${batch.id}/source-${n}`;
            await git(opts.repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${item.branch}:${ref}`]);
          } catch (e) {
            if (!isMissingRemoteRef(e, item.branch)) throw e;
            // Another machine's stale local ref is not evidence, so only this machine's own branch may be published.
            if (item.machineId !== batch.machineId) throw new Error(`${missingRemote(item.branch, remote)} Branch của máy khác (${item.machineId}): nhờ máy đó push nhánh rồi đưa lại vào hàng chờ.\n${errorText(e)}`);
            // The runner only pushes through MR/PR flows, so a machine without them never published the branch; push it here so the batch can fetch it.
            try {
              await git(opts.repo, ["push", remote, `refs/heads/${item.branch}:refs/heads/${item.branch}`]);
              await git(opts.repo, ["fetch", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${item.branch}:${ref}`]);
            } catch (e2) {
              throw new Error(`${missingRemote(item.branch, remote)} Máy này không push được nhánh: ${errorText(e2)}`);
            }
          }
        }
        outcome.sha = await git(opts.repo, ["rev-parse", `${ref}^{commit}`]);
        await git(worktree, ["-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", outcome.sha]);
      } catch (e) {
        outcome.status = "conflict";
        let conflict = "";
        try {
          conflict = await git(worktree, ["diff", "--no-ext-diff", "--no-color", "--cc"]);
        } catch {/* Git may have failed before merging. */}
        outcome.reason = redactLines(`${errorText(e)}\n${conflict}`).slice(0, 16000);
        try {
          await git(worktree, ["merge", "--abort"]);
        } catch {/* Missing ref has no merge to abort. */}
        await git(worktree, ["reset", "--hard", before]);
        await progress(`excluded: ${item.taskId}`, outcome.reason);
      }
    }
    if (!result.outcomes.some(o => o.status === "included")) throw new Error("All branches were excluded.");
    const checkedSha = await git(worktree, ["rev-parse", "HEAD"]);
    for (let n = 0; n < batch.config.commands.length; n++) {
      const command = batch.config.commands[n]!;
      let passed = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        await progress(`gate ${n + 1}/${batch.config.commands.length}${attempt ? " retry" : ""}: ${command}`);
        const gate = await runGate(command, worktree, env, opts.signal);
        await progress(result.step, gate.log);
        if (gate.ok) {
          passed = true;
          break;
        }
      }
      if (!passed) throw new Error(`Gate failed: ${command}`);
    }
    result.sha = await git(worktree, ["rev-parse", "HEAD"]);
    if (result.sha !== checkedSha) throw new Error("Gate changed HEAD.");
    if (await git(worktree, ["status", "--porcelain", "--untracked-files=no"])) throw new Error("Gate changed tracked files.");
    if (opts.releaseVersion) result.version = await opts.releaseVersion(result.sha);
    await progress("publish");
    save(result, "publishing");
    if (batch.config.mode === "mr") {
      if (!opts.openMr) throw new Error("MR publisher is unavailable.");
      result.url = await opts.openMr(branch);
      result.status = "awaiting";
      result.step = "awaiting";
      save(result, "awaiting");
    } else {
      if (opts.publish) await opts.publish(result.sha, batch.config.target);else {
        try {
          await git(opts.repo, ["push", remote, `${result.sha}:refs/heads/${batch.config.target}`]);
        } catch (e) {
          // Keep the journal in publishing while the remote is unreachable: a timeout is not proof of a rejected push.
          if (!(await landed(result.sha))) throw e;
        }
      }
      result.status = "landed";
      result.step = "landed";
      save(result, "complete");
    }
  } catch (e) {
    // MR creation is idempotent by source branch; a lost response must not abandon an already-open request.
    if (result.step === "publish" && batch.config.mode === "mr") {
      await progress("publish", errorText(e));
      throw e;
    }
    if (result.step === "publish" && result.sha && !opts.local) {
      if (await landed(result.sha)) {
        result.status = "landed";
        result.step = "landed";
        save(result, "complete");
        return result;
      }
    }
    result.status = "failed";
    result.log = redactLines(`${result.log}\n${errorText(e)}`).slice(-32000);
    save(result, "complete");
  }
  return result;
}
function runGate(command: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{
  ok: boolean;
  log: string;
}> {
  return new Promise(resolve => {
    let log = "";
    let ended = false;
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stop = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {/* Already exited. */}
    };
    const timer = setTimeout(stop, 30 * 60_000);
    const finish = (ok: boolean) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve({
        ok,
        log: redactLines(log)
      });
    };
    child.stdout.on("data", s => {
      log = (log + s).slice(-32000);
    });
    child.stderr.on("data", s => {
      log = (log + s).slice(-32000);
    });
    child.on("error", e => {
      log += e.message;
      finish(false);
    });
    child.on("close", code => finish(code === 0));
    signal?.addEventListener("abort", stop, {
      once: true
    });
    if (signal?.aborted) stop();
  });
}
export class MergeQueueRunner {
  #busy = false;
  get busy(): boolean { return this.#busy; }
  #abort = new AbortController();
  stop(): void {
    this.#abort.abort();
  }
  async settle(): Promise<void> {
    while (this.#busy) await new Promise(resolve => setTimeout(resolve, 10));
  }
  async poll(options: {
    execute?: typeof runMergeBatch;
    backend: HiveBackend;
    actor: Actor;
    instance: string;
    projects: DesktopProject[];
    dataDir: string;
    env: NodeJS.ProcessEnv;
    remote?: string;
    openMr?: (project: DesktopProject, branch: string) => Promise<string>;
  }): Promise<void> {
    if (this.#busy || this.#abort.signal.aborted) return;
    this.#busy = true;
    const dir = path.join(options.dataDir, "merge-queue");
    const lock = path.join(dir, "lock");
    let locked = false;
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(lock)) {
        const pid = Number(readFileSync(lock, "utf8"));
        try {
          process.kill(pid, 0);
          return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") return;
          unlinkSync(lock);
        }
      }
      writeFileSync(lock, String(process.pid), {
        flag: "wx"
      });
      locked = true;
      for (const project of options.projects) {
        const releases = await options.backend.call("autoRelease.list", { project: project.name }, options.actor);
        if (releases.paused) continue;
        const policy = await options.backend.call("sdlc.get", {}, options.actor);
        const releaseMachine = policy.projects[project.name]?.releaseMachine;
        const batch = await options.backend.call("mergeQueue.take", {
          project: project.name,
          instance: options.instance
        }, options.actor);
        if (!batch) continue;
        const key = createHash("sha256").update(JSON.stringify([batch.id, batch.createdAt, batch.project, batch.machineId])).digest("hex").slice(0, 24);
        const directory = path.join(dir, key);
        const result = await (options.execute ?? runMergeBatch)(batch, {
          repo: project.repo,
          directory,
          env: options.env,
          remote: options.remote,
          signal: this.#abort.signal,
          releaseVersion: releaseMachine ? async sha => {
            const manifest = project.name === "xdev-hive" ? "apps/desktop/package.json" : "package.json";
            const { stdout } = await exec("git", ["show", `${sha}:${manifest}`], { cwd: project.repo, env: options.env });
            return nextReleaseVersion(JSON.parse(stdout).version, releases.releases.map(r => r.batch.version));
          } : undefined,
          progress: async (step, log) => {
            await options.backend.call("mergeQueue.progress", {
              id: batch.id,
              instance: batch.instance,
              step: step.slice(0, 300),
              log
            }, options.actor);
          },
          openMr: options.openMr ? branch => options.openMr!({
            ...project,
            targetBranch: batch.config.target
          }, branch) : undefined
        });
        const runId = `MERGE-${batch.id}`;
        const artifacts = collectArtifacts(path.join(directory, "worktree"), 19);
        for (const file of [{
          name: "batch-result.json",
          data: Buffer.from(JSON.stringify(result, null, 2)).toString("base64")
        }, ...artifacts.files.filter(f => f.name !== "batch-result.json")]) {
          await options.backend.call("artifacts.put", {
            project: batch.project,
            taskId: batch.items[0]!.taskId,
            runId,
            profileId: null,
            name: file.name,
            data: file.data
          }, options.actor);
        }
        await options.backend.call("mergeQueue.finish", {
          id: batch.id,
          instance: batch.instance,
          result
        }, options.actor);
        if (result.status !== "awaiting") break;
      }
    } finally {
      try { if (locked) unlinkSync(lock); } finally { this.#busy = false; }
    }
  }
}

/** Reserve above both the checked manifest and prior receipts, including failed releases. */
export function nextReleaseVersion(current: string, reserved: string[]): string {
  const versions = [current, ...reserved];
  if (versions.some(v => !/^\d+\.\d+\.\d+$/.test(v))) throw new Error("Release needs a stable manifest version.");
  const [major, minor, patch] = versions.map(v => v.split(".").map(Number)).sort((a, b) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!)[0]!;
  return `${major}.${minor}.${patch! + 1}`;
}
