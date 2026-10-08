import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";

const git = (repo, args) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  // A caller's index/worktree overrides must not redirect SHA checks or the disposable clone.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  return execFileSync("git", ["-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"), ...args], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 30_000,
  }).trim();
};

export function assertPreviewCurrent({ repo, sourceRef, sha, target, baseSha, gate, expiresAt, worktree }, now = Date.now()) {
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Preview requires a full commit SHA");
  if (now >= Date.parse(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) throw new Error("Preview expired");
  if (!gate || gate.sha !== sha || !gate.checks?.length || gate.checks.some(c => c.status !== "passed")) throw new Error("Preview needs green gates on the same SHA");
  if (git(repo, ["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`]) !== sha) throw new Error("Preview source SHA is stale");
  if (git(repo, ["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`]) !== baseSha) throw new Error("Preview target SHA is stale");
  if (worktree && (git(worktree, ["rev-parse", "HEAD"]) !== sha || git(worktree, ["status", "--porcelain"]))) throw new Error("Preview checkout changed");
}

// No production HIVE_*, cloud credentials or Git overrides reach the disposable hub.
export function previewEnv(directory, port, sha) {
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG", "LC_ALL"])
    if (process.env[key]) env[key] = process.env[key];
  return { ...env, NODE_ENV: "production", HIVE_HOST: "127.0.0.1", HIVE_PORT: String(port),
    HIVE_DB: join(directory, "hub.db"), HIVE_BACKUP_DIR: join(directory, "backups"),
    HIVE_BOOTSTRAP_TOKEN: randomBytes(32).toString("hex"), HIVE_COMMIT: sha };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function stopChild(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group has already exited. */ }
}

async function command(cwd, executable, args, env, signal) {
  signal.throwIfAborted();
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: "ignore" });
  const stop = () => stopChild(child);
  signal.addEventListener("abort", stop, { once: true });
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (signal.aborted) reject(signal.reason);
        else if (code === 0) resolve();
        else reject(new Error(`Preview command failed: ${executable} (exit ${code})`));
      });
      if (signal.aborted) stop();
    });
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}

export async function confirmPreview({ sha, url, loginFile, signal }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Preview approval requires an interactive terminal");
  console.log(`Preview: ${url}\nSHA: ${sha}\nTemporary login token (owner only): ${loginFile}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question("Inspect the app, then type its full SHA to approve (anything else rejects): ", { signal })).trim(); }
  finally { rl.close(); }
}

/** Foreground ownership keeps approval, TTL and process cleanup in one lifetime. */
export async function appPreview(options) {
  if (process.platform === "win32") throw new Error("Application preview currently requires POSIX process groups");
  const { repo, sourceRef, sha, target, baseSha, gate, ttlMinutes = 30 } = options;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 120) throw new Error("Preview TTL must be 1–120 minutes");
  if (!options.confirm && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("Preview approval requires an interactive terminal");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const scope = { repo, sourceRef, sha, target, baseSha, gate, expiresAt };
  assertPreviewCurrent(scope);
  const progress = options.progress ?? (process.stdout.isTTY ? message => console.log(message) : () => {});
  const directory = mkdtempSync(join(tmpdir(), "hive-preview-"));
  const worktree = join(directory, "checkout");
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Preview stopped"));
  const timer = setTimeout(() => controller.abort(new Error("Preview expired")), ttlMinutes * 60_000);
  const receipt = { sha, sourceRef, target, baseSha, gateSha: gate.sha,
    gateChecks: gate.checks.map(({ name, status }) => ({ name, status })),
    createdAt, expiresAt, status: "rejected", approvedAt: null };
  let child;
  for (const event of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(event, abort);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    progress(`Preparing isolated preview at ${sha} (expires ${expiresAt})`);
    // A private clone also works when the caller may read but cannot write the source's common .git.
    // Copy objects rather than sharing them: preview cleanup never touches source Git metadata.
    git(repo, ["clone", "--local", "--no-hardlinks", "--no-checkout", "--", repo, worktree]);
    git(worktree, ["remote", "remove", "origin"]);
    git(worktree, ["checkout", "--detach", sha]);
    const port = await freePort();
    const env = previewEnv(directory, port, sha);
    // The token is never in artifacts, reports, argv or process output.
    const loginFile = join(directory, "login.txt");
    writeFileSync(loginFile, env.HIVE_BOOTSTRAP_TOKEN + "\n", { mode: 0o600 });
    const steps = options.steps ?? [["npm", ["ci", "--prefer-offline", "--include=dev"]], ["npm", ["run", "build", "-w", "@xdev-hive/web"]]];
    for (const [executable, args] of steps) {
      progress(`Preview build: ${executable} ${args.join(" ")}`);
      await command(worktree, executable, args, env, controller.signal);
    }
    assertPreviewCurrent({ ...scope, worktree });
    const [executable, args] = options.server ?? [process.execPath, ["apps/web/src/server.ts"]];
    controller.signal.throwIfAborted();
    child = spawn(executable, args, { cwd: worktree, env, detached: true, stdio: "ignore" });
    child.once("error", abort);
    child.once("exit", abort);
    const kill = () => stopChild(child);
    controller.signal.addEventListener("abort", kill, { once: true });
    const url = `http://127.0.0.1:${port}`;
    progress("Waiting for preview health…");
    for (let n = 0; ; n++) {
      controller.signal.throwIfAborted();
      if (await fetch(`${url}/api/health`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) }).then(r => r.ok, () => false)) break;
      if (n >= 99) throw new Error("Preview did not become healthy");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const approved = await (options.confirm ?? confirmPreview)({ sha, url, loginFile, signal: controller.signal });
    controller.signal.throwIfAborted();
    assertPreviewCurrent({ ...scope, worktree });
    if (approved === sha) { receipt.status = "approved"; receipt.approvedAt = new Date().toISOString(); }
    return receipt;
  } finally {
    controller.abort();
    stopChild(child ?? {});
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    for (const event of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeListener(event, abort);
    // Only this invocation's private clone is removed; source and target Git metadata are untouched.
    rmSync(directory, { recursive: true, force: true });
  }
}
