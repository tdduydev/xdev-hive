// Local spike only: deliberately not connected to IPC, MCP, heartbeat or the hub.
import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import type { IPty, IPtyForkOptions } from "node-pty";

export interface LocalPolicy {
  enabled: true;
  osUser: string;
  projects: Record<string, string>;
  maxSessionMs: number;
}
export type Audit = { type: "spawn" | "resize" | "sensitive-input" | "close"; bytes?: number; cols?: number; rows?: number };
export interface PtyBackend { spawn(shell: string, args: string[], options: IPtyForkOptions): IPty }

export function readLocalPolicy(path: string): LocalPolicy {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || st.size > 16_384) throw 0;
    const p = JSON.parse(readFileSync(fd, "utf8"));
    if (p.enabled !== true || p.osUser !== userInfo().username || !p.projects || typeof p.projects !== "object" || Array.isArray(p.projects)
      || !Number.isInteger(p.maxSessionMs) || p.maxSessionMs < 1000 || p.maxSessionMs > 7_200_000
      || Object.values(p.projects).some(v => typeof v !== "string" || !v.startsWith("/"))) throw 0;
    return p;
  } catch { throw new Error("terminal-local-policy-denied"); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function dimensions(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) throw new Error("terminal-size-invalid");
}

// Interactive jobs may have their own process groups. Snapshot descendants before
// terminating the shell, since orphaned jobs no longer retain their parent link.
function processSnapshot(): Map<number, { parent: number; group: number; started: string }> {
  const lines = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024,
  }).trim().split("\n");
  return new Map(lines.map(line => {
    const [pid, parent, group, ...started] = line.trim().split(/\s+/);
    return [Number(pid), { parent: Number(parent), group: Number(group), started: started.join(" ") }];
  }));
}

function stopTree(pid: number): Promise<void> {
  const ids = new Set([pid]);
  let before: ReturnType<typeof processSnapshot>;
  try {
    before = processSnapshot();
    let changed = true;
    while (changed) {
      changed = false;
      for (const [child, info] of before) if (ids.has(info.parent) && !ids.has(child)) { ids.add(child); changed = true; }
    }
  } catch {
    // Without process identities, never schedule a delayed kill against a PID
    // that could have been recycled. Cleanup is explicitly best effort.
    try { process.kill(-pid, "SIGTERM"); } catch { /* Group already exited. */ }
    return Promise.resolve();
  }
  const signal = (sig: NodeJS.Signals, current: ReturnType<typeof processSnapshot>) => {
    for (const id of [...ids].reverse()) {
      const original = before.get(id);
      const live = current.get(id);
      if (!original || !live || original.started !== live.started) continue;
      if (live.group === id) try { process.kill(-id, sig); } catch { /* Group already exited. */ }
      try { process.kill(id, sig); } catch { /* Process already exited. */ }
    }
  };
  signal("SIGTERM", before);
  return new Promise(resolve => setTimeout(() => {
    try { signal("SIGKILL", processSnapshot()); } catch { /* Cannot safely identify survivors. */ }
    resolve();
  }, 5000));
}

export class PtySupervisor {
  #pty?: IPty;
  #timer?: ReturnType<typeof setInterval>;
  #closing?: Promise<void>;
  #project?: string;
  #cwd?: string;
  #deadline = 0;
  #started = 0;
  #idleDeadline = 0;
  #backend?: PtyBackend;
  private readonly options: {
    policyFile: string;
    audit: (event: Audit) => undefined;
    output: (data: string) => void;
    exit: (event: { exitCode: number; signal?: number; cleanupUncertain: true }) => void;
    backend?: PtyBackend;
  };
  constructor(options: PtySupervisor["options"]) { this.options = options; this.#backend = options.backend; }

  #audit(event: Audit): void {
    const result: unknown = this.options.audit(event);
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      throw new Error("terminal-audit-must-be-synchronous");
    }
  }

  #allowed(project: string): { policy: LocalPolicy; cwd: string } {
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("terminal-platform-unsupported");
    const policy = readLocalPolicy(this.options.policyFile);
    const root = Object.hasOwn(policy.projects, project) && policy.projects[project];
    if (!root) throw new Error("terminal-project-denied");
    const cwd = realpathSync(root);
    if (!statSync(cwd).isDirectory()) throw new Error("terminal-cwd-invalid");
    return { policy, cwd };
  }

  spawn(project: string, cols = 80, rows = 24): void {
    if (this.#pty || this.#closing) throw new Error("terminal-busy");
    dimensions(cols, rows);
    const { policy, cwd } = this.#allowed(project);
    // Never inherit machine tokens, agent credentials, shell hooks or preload env.
    const user = userInfo();
    const env = { HOME: user.homedir, USER: user.username, LOGNAME: user.username, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TERM: "xterm-256color", LANG: "en_US.UTF-8", HISTFILE: "/dev/null", HISTSIZE: "0", HISTFILESIZE: "0", PS1: "hive-spike$ " };
    this.#audit({ type: "spawn", cols, rows });
    this.#backend ??= createRequire(import.meta.url)("node-pty") as PtyBackend;
    const pty = this.#backend.spawn("/bin/bash", ["--noprofile", "--norc", "-i"], { cwd, env, cols, rows, name: "xterm-256color" });
    this.#pty = pty;
    this.#project = project;
    this.#cwd = cwd;
    this.#started = performance.now();
    this.#deadline = this.#started + policy.maxSessionMs;
    this.#idleDeadline = performance.now() + 900_000;
    pty.onData(data => { try { this.options.output(data); } catch { void this.stop(); } });
    pty.onExit(event => {
      // Closing the shell can leave background jobs; always attempt cleanup.
      void this.stop();
      try { this.options.exit({ ...event, cleanupUncertain: true }); } catch { /* Consumer failure must not interrupt cleanup. */ }
    });
    this.#timer = setInterval(() => { try { this.#check(); } catch { void this.stop(); } }, 250);
  }

  #check(): IPty {
    if (!this.#pty || this.#closing) throw new Error("terminal-not-active");
    try {
      const { cwd, policy } = this.#allowed(this.#project!);
      if (cwd !== this.#cwd || performance.now() >= this.#deadline || performance.now() >= this.#idleDeadline
        || performance.now() >= this.#started + policy.maxSessionMs) throw new Error("terminal-policy-expired");
      return this.#pty;
    } catch { void this.stop(); throw new Error("terminal-local-policy-denied"); }
  }

  /** Bytes as the browser sent them: a Buffer keeps a UTF-8 sequence split across two frames whole. */
  write(data: string | Buffer): void {
    const pty = this.#check();
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    if (bytes > 16_384) throw new Error("terminal-input-too-large");
    // node-pty has no public tcgetattr API. Omit ALL input payloads, even with
    // echo on, rather than racing a password prompt or guessing from output.
    try { this.#audit({ type: "sensitive-input", bytes }); pty.write(data); }
    catch { void this.stop(); throw new Error("terminal-input-failed"); }
    this.#idleDeadline = performance.now() + 900_000;
  }

  resize(cols: number, rows: number): void {
    dimensions(cols, rows);
    const pty = this.#check();
    try { this.#audit({ type: "resize", cols, rows }); pty.resize(cols, rows); }
    catch { void this.stop(); throw new Error("terminal-resize-failed"); }
  }

  /** Backpressure (spec 69 §7): the browser is behind, so the shell blocks on its own output instead of us buffering it. */
  pause(): void { if (this.#pty && !this.#closing) this.#pty.pause(); }
  resume(): void { if (this.#pty && !this.#closing) this.#pty.resume(); }

  get running(): boolean { return !!this.#pty; }

  stop(): Promise<void> {
    if (this.#closing) return this.#closing;
    const pty = this.#pty;
    if (!pty) return Promise.resolve();
    clearInterval(this.#timer);
    // Retain the occupied slot through escalation, including after shell exit.
    this.#closing = stopTree(pty.pid).finally(() => { this.#pty = undefined; this.#closing = undefined; });
    try { this.#audit({ type: "close" }); } catch { /* Audit failure must never prevent local emergency stop. */ }
    return this.#closing;
  }
}
