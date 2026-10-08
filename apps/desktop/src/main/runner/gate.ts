// Gate jobs on this machine (spec 69h1, executor 69h2): a template the person at the machine declared in a local
// policy file runs on one exact commit, in a fresh clone, outside every coding run's sandbox, and answers with a
// receipt. The hub never sends a command: it names a template by hash, and nothing runs unless the local template
// still hashes the same. Same user means no isolation (§6.5): this only keeps the gate from becoming a remote shell
// or a way for a run to get more than its sandbox.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  ARTIFACT_MAX_BYTES, ARTIFACTS_PER_RUN, GATE_PROTOCOL, GATE_RESULT_MAX_BYTES, checkArtifact, expandGateArgv, findSecret, gateGlobMatch, gateManifest, gateOutcome,
  gateResultFileSchema, gateTemplateSchema, isArtifactText, redactLines,
  type Actor, type DesktopProject, type GateCapability, type GateHeartbeatReply, type GateJob, type GateReason, type GateReceipt, type GateResultFile,
  type GateTemplate, type HiveBackend,
} from "@xdev-hive/core";
import { gateManifestHash, gateTemplateHash } from "@xdev-hive/core/node";
import { killTree } from "#desktop/main/runner/kill.ts";
import type { ResourceLocks } from "#desktop/main/resource-locks.ts";

const exec = promisify(execFile);

export const GATE_POLICY_FILE = "gate-jobs.json";
const POLICY_MAX_BYTES = 64 * 1024;
/** Env names a template may never ask for, besides HIVE_* and the profiles' own: the agents' and the forges' keys. */
export const GATE_SECRET_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GITLAB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
const PROGRESS_MS = 30_000;
const LOG_TAIL = 4096;
const WALK_DEPTH = 4;

/** What the person at the machine wrote: on, for which OS user, and the templates of each project. */
export interface GatePolicy {
  enabled: true;
  osUser: string;
  projects: Record<string, { autoApprove: boolean; templates: GateTemplate[] }>;
}

/**
 * The policy as the remote terminal reads its own (69b): a regular file of this user, 0600, not a symlink, small.
 * A template whose argv holds a known secret or whose env names a Hive or profile secret makes the whole file void,
 * so a mistake is seen at once instead of one template quietly missing.
 */
export function readGatePolicy(file: string, secretEnv: ReadonlySet<string>): GatePolicy {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > POLICY_MAX_BYTES) throw new Error("mode");
    const raw = JSON.parse(readFileSync(fd, "utf8")) as { enabled?: unknown; osUser?: unknown; projects?: unknown };
    if (raw.enabled !== true || raw.osUser !== os.userInfo().username || !raw.projects || typeof raw.projects !== "object" || Array.isArray(raw.projects)) throw new Error("shape");
    const projects: GatePolicy["projects"] = {};
    for (const [name, p] of Object.entries(raw.projects as Record<string, { autoApprove?: unknown; templates?: unknown }>)) {
      const templates = (Array.isArray(p?.templates) ? p.templates : [null]).map((t) => gateTemplateSchema.parse(t));
      if (new Set(templates.map((t) => t.id)).size !== templates.length) throw new Error("duplicate id");
      for (const t of templates) {
        if (findSecret(JSON.stringify(t.argv))) throw new Error("secret in argv");
        if (t.env.some((n) => n.startsWith("HIVE_") || secretEnv.has(n))) throw new Error("secret env name");
      }
      projects[name] = { autoApprove: p?.autoApprove === true, templates };
    }
    return { enabled: true, osUser: raw.osUser, projects };
  } catch {
    throw new Error("gate-local-policy-denied");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A real GUI session, not the app's say-so (spec 69h1 §11): Aqua on macOS, a display on Linux. */
export async function detectGui(): Promise<GateReceipt["gui"]> {
  if (process.platform === "darwin") {
    try { return (await exec("/bin/launchctl", ["managername"], { timeout: 5000 })).stdout.trim() === "Aqua" ? "aqua" : "none"; }
    catch { return "none"; }
  }
  if (process.platform === "linux") return process.env.WAYLAND_DISPLAY ? "wayland" : process.env.DISPLAY ? "x11" : "none";
  return "none";
}

export interface GateHost {
  backend(): HiveBackend;
  actor(): Actor;
  projects(): DesktopProject[];
  /** The login-shell env: PATH and the values of the names a template lists come from here, nothing else. */
  env(): NodeJS.ProcessEnv;
  /** Hub mode, not draining for an update, no merge batch or release in this project now. */
  allowed(project: string): boolean;
  locks: ResourceLocks;
  /** Env names of the profiles' and the hub's secrets: a template may not ask for them. */
  secretEnv(): string[];
  /** Literal secrets (hub token, profile tokens) that must not leave in a log tail or a text artifact. */
  known(): string[];
  version: string;
  gui?: () => Promise<GateReceipt["gui"]>;
  log(line: string): void;
  /** Tests: shorter progress beats and minutes. */
  progressMs?: number;
  minuteMs?: number;
}

interface Pending { id: string; leaseToken: string; receipt: GateReceipt }

export class GateExecutor {
  readonly policyFile: string;
  readonly dir: string;
  readonly #host: GateHost;
  readonly #acked = new Set<string>();
  #inflight: Promise<void> | null = null;
  #polling = false;
  #stopped = false;
  #cancel: (() => void) | null = null;

  constructor(host: GateHost, dataDir: string) {
    this.#host = host;
    this.policyFile = path.join(dataDir, GATE_POLICY_FILE);
    this.dir = path.join(dataDir, "gate");
  }

  get busy(): boolean { return this.#polling || !!this.#inflight; }
  /** The project a gate job holds: merge batches and releases of it wait (spec 69h1 §7). */
  holds(project: string): boolean { return this.#host.locks.holder(project, "gate") === "gate"; }
  stop(): void { this.#stopped = true; this.#cancel?.(); }
  async settle(): Promise<void> { while (this.#polling) await new Promise((r) => setTimeout(r, 10)); await this.#inflight; }

  #policy(): GatePolicy | null {
    try { return readGatePolicy(this.policyFile, new Set(this.#host.secretEnv())); } catch { return null; }
  }

  /** The heartbeat's gate field: the index every beat, the manifests the hub has not ACKed yet (§3). */
  capability(): GateCapability | undefined {
    const policy = this.#policy();
    if (!policy) return undefined;
    const known = new Map(this.#host.projects().map((p) => [p.name, p]));
    const projects = Object.entries(policy.projects).filter(([name]) => known.has(name)).map(([name, p]) => ({
      name,
      // Never with a local release configuration for the project: agent code would run as the user who can publish.
      autoApprove: p.autoApprove && !known.get(name)!.autoRelease,
      templates: p.templates.map((t) => ({ id: t.id, version: t.version, hash: gateTemplateHash(t), label: t.label })),
    }));
    const manifests: GateCapability["manifests"] = [];
    let bytes = 0;
    for (const t of projects.flatMap((p) => policy.projects[p.name]!.templates)) {
      const manifest = gateManifest(t);
      const hash = gateManifestHash(manifest);
      const size = JSON.stringify(manifest).length;
      if (this.#acked.has(hash) || manifests.some((m) => m.hash === hash) || manifests.length >= 8 || bytes + size > 60 * 1024) continue;
      bytes += size;
      manifests.push({ hash, manifest });
    }
    return { protocol: GATE_PROTOCOL, enabled: true, guiReady: process.platform === "darwin" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY, busy: this.busy, projects, manifests };
  }

  onHub(reply: GateHeartbeatReply | undefined): void {
    for (const h of reply?.ack ?? []) this.#acked.add(h);
    for (const h of reply?.want ?? []) this.#acked.delete(h);
  }

  /** Receipts first (a lost reply resends the receipt, never the command), then at most one job. */
  async poll(): Promise<void> {
    if (this.busy || this.#stopped) return;
    this.#polling = true;
    try {
      await this.#resend();
      const policy = this.#policy();
      if (!policy) return;
      for (const project of this.#host.projects()) {
        const local = policy.projects[project.name];
        if (!local?.templates.length || !this.#host.allowed(project.name)) continue;
        const lock = this.#host.locks.acquire(project.name, "gate", "gate", "take");
        if ("heldBy" in lock) continue;
        const gui = local.templates.some((t) => t.gui) ? this.#host.locks.acquire("*", "gui", "gate", "take") : null;
        if (gui && "heldBy" in gui) { lock.release(); continue; }
        const release = () => { lock.release(); if (gui && "release" in gui) gui.release(); };
        let taken: { job: GateJob; leaseToken: string } | null = null;
        try { taken = await this.#host.backend().call("gate.take", { project: project.name }, this.#host.actor()); }
        catch { /* The hub is away: nothing taken, try again at the next beat. */ }
        if (!taken) { release(); continue; }
        this.#inflight = this.#execute(taken.job, taken.leaseToken, project, local).catch((err) => this.#host.log(`gate ${taken!.job.id}: ${(err as Error).message}`))
          .finally(() => { release(); this.#inflight = null; this.#cancel = null; });
        break;
      }
    } finally { this.#polling = false; }
  }

  async #resend(): Promise<void> {
    const dir = path.join(this.dir, "receipts");
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const file = path.join(dir, name);
      const p = JSON.parse(readFileSync(file, "utf8")) as Pending;
      try { await this.#report(p); rmSync(file); }
      catch (err) { this.#host.log(`gate ${p.id}: receipt not delivered yet (${(err as Error).message})`); }
    }
  }

  async #report(p: Pending): Promise<GateJob> {
    const job = await this.#host.backend().call("gate.result", { id: p.id, leaseToken: p.leaseToken, receipt: p.receipt }, this.#host.actor());
    // Only once the hub has the receipt: the clone may hold node_modules and is no evidence the receipt lacks.
    rmSync(path.join(this.dir, key(p.id), "clone"), { recursive: true, force: true });
    return job;
  }

  async #execute(job: GateJob, leaseToken: string, project: DesktopProject, local: GatePolicy["projects"][string]): Promise<void> {
    const work = path.join(this.dir, key(job.id));
    const clone = path.join(work, "clone");
    const artifactDir = path.join(work, "artifacts");
    const logFile = path.join(work, "log");
    const startedAt = new Date().toISOString();
    const template = local.templates.find((t) => t.id === job.templateId);
    const facts = { exitCode: null as number | null, signal: null as string | null, timedOut: false, checkedSha: "", treeClean: false, result: null as GateResultFile | null, artifacts: [] as GateReceipt["artifacts"] };
    const gui = await (this.#host.gui ?? detectGui)();
    let infra: GateReason | null = null;
    let cancelled = false;
    let outcome: { outcome: GateReceipt["outcome"]; reason: GateReason | null };
    let beat: NodeJS.Timeout | null = null;
    try {
      // The hash of the template here, now, must be the one the person approved; anything else runs nothing.
      if (!template || gateTemplateHash(template) !== job.templateHash) throw new Infra("templateChanged");
      if (job.batchId !== null) throw new Infra("batchEnded");
      if (job.approval?.mode === "auto" && !(local.autoApprove && !project.autoRelease)) throw new Infra("autoApproveRevoked");
      if (template.gui && gui === "none") throw new Infra("noGui");
      if (existsSync(work)) throw new Infra("cloneFailed");
      mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
      mkdirSync(path.join(work, "tmp"), { recursive: true, mode: 0o700 });
      const state = await this.#progress(job.id, leaseToken, "clone");
      if (state !== "running") throw new Infra(state === "cancelled" ? "cancelled" : "leaseLost");
      await this.#clone(project.repo, clone, job).catch((err) => { throw err instanceof Infra ? err : new Infra("cloneFailed"); });
      const env = this.#env(template, job, artifactDir, path.join(work, "tmp"));
      const argv = expandGateArgv(template.argv, { sha: job.sha, jobId: job.id, artifactDir });
      const run = this.#spawn(argv, clone, env, logFile, template.timeoutMinutes);
      beat = setInterval(() => void this.#progress(job.id, leaseToken, "run").then((s) => {
        if (s === "running") return;
        cancelled = s === "cancelled";
        if (!cancelled) infra = "leaseLost";
        this.#cancel?.();
      }), this.#host.progressMs ?? PROGRESS_MS);
      const exit = await run;
      clearInterval(beat); beat = null;
      Object.assign(facts, exit);
      const git = (...args: string[]) => this.#git(clone, ...args);
      facts.checkedSha = await git("rev-parse", "HEAD").catch(() => "");
      facts.treeClean = (await git("status", "--porcelain", "--untracked-files=no").catch(() => "?")) === "";
      const resultRead = template.resultFile ? readResult(artifactDir, template.resultFile) : null;
      facts.result = resultRead === "invalid" ? null : resultRead;
      const { files, missing } = collectArtifacts(artifactDir, template);
      if (!cancelled && !infra) {
        await this.#progress(job.id, leaseToken, "upload");
        facts.artifacts = await this.#upload(job.id, leaseToken, files, template).catch(() => { throw new Infra("uploadFailed"); });
      }
      outcome = infra ? { outcome: "error", reason: infra }
        : gateOutcome({ ...exit, cancelled, resultExpected: !!template.resultFile, result: resultRead, missingRequired: missing, headMatches: facts.checkedSha === job.sha, treeClean: facts.treeClean });
    } catch (err) {
      if (beat) clearInterval(beat);
      const reason = err instanceof Infra ? err.reason : "cloneFailed";
      outcome = reason === "cancelled" ? { outcome: "cancelled", reason } : { outcome: "error", reason };
      if (!(err instanceof Infra)) this.#host.log(`gate ${job.id}: ${(err as Error).message}`);
    }
    const receipt: GateReceipt = {
      jobId: job.id, project: job.project, machineId: job.machineId, templateId: job.templateId, templateHash: job.templateHash, sha: job.sha,
      checkedSha: facts.checkedSha, treeClean: facts.treeClean, startedAt, finishedAt: new Date().toISOString(),
      exitCode: facts.exitCode, signal: facts.signal, timedOut: facts.timedOut, result: facts.result && this.#cleanResult(facts.result, template), artifacts: facts.artifacts,
      logSha256: existsSync(logFile) ? createHash("sha256").update(readFileSync(logFile)).digest("hex") : null,
      logTail: existsSync(logFile) ? this.#redact(tail(logFile), template) : "",
      app: this.#host.version, os: { platform: process.platform, release: os.release() }, gui, ...outcome,
    };
    // On disk before the RPC (spec 69h1 §8): a lost reply resends this, never the command.
    const pending: Pending = { id: job.id, leaseToken, receipt };
    const dir = path.join(this.dir, "receipts");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${key(job.id)}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(pending), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.#host.log(`gate ${job.id}: ${receipt.outcome}${receipt.reason ? ` (${receipt.reason})` : ""} on ${job.sha.slice(0, 12)}`);
    try { await this.#report(pending); rmSync(file); }
    catch (err) { this.#host.log(`gate ${job.id}: receipt kept for the next beat (${(err as Error).message})`); }
  }

  async #progress(id: string, leaseToken: string, step: string): Promise<string> {
    try { return (await this.#host.backend().call("gate.progress", { id, leaseToken, step }, this.#host.actor())).state; }
    catch (err) {
      // Refused (not the lease any more) ends the run; an unreachable hub does not, the lease decides there.
      return (err as { code?: string }).code === "forbidden" ? "leaseLost" : "running";
    }
  }

  /**
   * A clone of the project's repo for this job only: objects from the local repo, the ref from its origin when it has
   * one (a local fixture has none), the SHA on that ref, then no remote left and the SHA checked out detached.
   */
  async #clone(repo: string, clone: string, job: GateJob): Promise<void> {
    await this.#git(path.dirname(clone), "clone", "--no-hardlinks", "--no-checkout", "--quiet", "--", repo, clone);
    let remote: string | null = null;
    try { remote = await this.#git(repo, "remote", "get-url", "origin"); } catch { /* no remote: the local ref decides */ }
    let tip: string;
    if (remote) {
      await this.#git(clone, "remote", "set-url", "origin", remote);
      await this.#git(clone, "fetch", "--no-tags", "--quiet", "origin", `refs/heads/${job.ref}`);
      tip = await this.#git(clone, "rev-parse", "FETCH_HEAD");
    } else tip = await this.#git(clone, "rev-parse", "--verify", "--end-of-options", `refs/remotes/origin/${job.ref}^{commit}`).catch(() => { throw new Infra("shaNotOnRef"); });
    // Not before the ref is known: a SHA present in the clone but on no branch of the ref proves nothing.
    try { await this.#git(clone, "merge-base", "--is-ancestor", job.sha, tip); }
    catch { throw new Infra("shaNotOnRef"); }
    await this.#git(clone, "remote", "remove", "origin");
    await this.#git(clone, "checkout", "--quiet", "--detach", job.sha);
  }

  async #git(cwd: string, ...args: string[]): Promise<string> {
    const env = { ...this.#host.env(), GIT_TERMINAL_PROMPT: "0" };
    return (await exec("git", args, { cwd, timeout: 10 * 60_000, env, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  }

  /** From scratch (spec 69h1 §6.4): no machine token, run or MCP credential, profile env or release variable. */
  #env(template: GateTemplate, job: GateJob, artifactDir: string, tmp: string): NodeJS.ProcessEnv {
    const from = this.#host.env();
    const user = os.userInfo();
    const env: NodeJS.ProcessEnv = {
      PATH: from.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: user.homedir, USER: user.username, LOGNAME: user.username,
      LANG: from.LANG ?? "en_US.UTF-8", TMPDIR: tmp, TERM: "dumb", GIT_TERMINAL_PROMPT: "0",
      HIVE_GATE_JOB: job.id, HIVE_GATE_SHA: job.sha, HIVE_GATE_ARTIFACTS: artifactDir,
    };
    if (from.LC_ALL) env.LC_ALL = from.LC_ALL;
    if (process.platform === "linux") for (const n of ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (process.env[n]) env[n] = process.env[n];
    for (const n of template.env) if (from[n] !== undefined) env[n] = from[n];
    return env;
  }

  #spawn(argv: string[], cwd: string, env: NodeJS.ProcessEnv, logFile: string, timeoutMinutes: number): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }> {
    if (this.#stopped) return Promise.reject(new Infra("cancelled"));
    return new Promise((resolve, reject) => {
      const fd = openSync(logFile, "a", 0o600);
      // No shell: argv[0] is the program and every element one argument, whatever it holds.
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", fd, fd] });
      closeSync(fd);
      let timedOut = false;
      this.#cancel = () => killTree(child);
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMinutes * (this.#host.minuteMs ?? 60_000));
      child.once("error", () => { clearTimeout(timer); reject(new Infra("cloneFailed")); });
      child.once("close", (code, signal) => { clearTimeout(timer); this.#cancel = null; resolve({ exitCode: code, signal: signal ?? null, timedOut }); });
    });
  }

  async #upload(id: string, leaseToken: string, files: { rel: string; abs: string }[], template: GateTemplate): Promise<GateReceipt["artifacts"]> {
    const out: GateReceipt["artifacts"] = [];
    for (const f of files) {
      let bytes: Uint8Array = readFileSync(f.abs);
      const type = checkArtifact(f.rel, bytes);
      // Text is filtered before it leaves; an image goes as it is (spec 69h1 §8), which is why only the allowlist goes.
      if (isArtifactText(type)) bytes = new TextEncoder().encode(this.#redact(new TextDecoder().decode(bytes), template));
      await this.#host.backend().call("gate.artifact", { id, leaseToken, name: f.rel, data: Buffer.from(bytes).toString("base64") }, this.#host.actor());
      out.push({ name: f.rel, type, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), required: template.artifacts.some((a) => a.required && gateGlobMatch(a.glob, f.rel)) });
    }
    return out;
  }

  /** Known secrets of the hub, the profiles and the values of the env names this template got. */
  #redact(text: string, template: GateTemplate | undefined): string {
    const env = this.#host.env();
    const values = [...this.#host.known(), ...(template?.env ?? []).map((n) => env[n] ?? "")].filter((v) => v.length > 0);
    for (const v of values) text = text.split(v).join("[hidden]");
    return redactLines(text);
  }

  #cleanResult(r: GateResultFile, template: GateTemplate | undefined): GateResultFile {
    return { ...r, ...(r.summary === undefined ? {} : { summary: this.#redact(r.summary, template).slice(0, 4000) }),
      ...(r.checks ? { checks: r.checks.map((c) => ({ ...c, name: this.#redact(c.name, template).slice(0, 200) })) } : {}) };
  }
}

class Infra extends Error {
  readonly reason: GateReason;
  constructor(reason: GateReason) { super(reason); this.reason = reason; }
}

const key = (jobId: string) => createHash("sha256").update(jobId).digest("hex").slice(0, 32);

function tail(file: string): string {
  const buf = readFileSync(file);
  return buf.subarray(Math.max(0, buf.length - LOG_TAIL)).toString("utf8");
}

/** Inside the artifact folder only, by realpath; never through a link. */
function inside(root: string, abs: string): boolean {
  try {
    const real = realpathSync(abs);
    const base = realpathSync(root);
    return real.startsWith(base + path.sep) && !lstatSync(abs).isSymbolicLink();
  } catch { return false; }
}

export function readResult(root: string, rel: string): GateResultFile | "invalid" {
  const abs = path.join(root, rel);
  let fd: number | undefined;
  try {
    if (!inside(root, abs)) return "invalid";
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > GATE_RESULT_MAX_BYTES) return "invalid";
    const parsed = gateResultFileSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    return parsed.success ? parsed.data : "invalid";
  } catch { return "invalid"; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The files the manifest names, under the artifact rules of 41: no link, nothing outside by realpath, a known type,
 * at most 5 MB each and 20 in all. What a required glob does not find is counted as missing.
 */
export function collectArtifacts(root: string, template: GateTemplate): { files: { rel: string; abs: string }[]; missing: number } {
  const found: { rel: string; abs: string }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > WALK_DEPTH) return;
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const name of entries) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, r, depth + 1);
      else if (st.isFile() && st.size > 0 && st.size <= ARTIFACT_MAX_BYTES && template.artifacts.some((a) => gateGlobMatch(a.glob, r)) && inside(root, abs)) {
        try { checkArtifact(r, readFileSync(abs)); found.push({ rel: r, abs }); } catch { /* not a type the hub keeps */ }
      }
    }
  };
  walk(root, "", 0);
  const files = found.slice(0, ARTIFACTS_PER_RUN);
  const missing = template.artifacts.filter((a) => a.required && !files.some((f) => gateGlobMatch(a.glob, f.rel))).length;
  return { files, missing };
}
