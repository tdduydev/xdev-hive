// The Docs writing assistant (roadmap 22k): this machine takes an ask the hub (or, without a hub, this app's own
// database) holds, and writes it once with one of its Claude profiles. The ask carries the page and the sources the
// person picked; repo files are read here, in the project's checkout, which Claude may read but not change. No MCP, no
// commands. The answer is a short reply and the whole page as proposed, which the person applies to a draft or drops.
import { execFileSync } from "node:child_process";
import { spawnCli } from "#desktop/main/spawn-cli.ts";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { toErrorPayload, type Actor, type AgentProfile, type DesktopProject, type DocAssistJob, type HiveBackend, type RunRequestError } from "@xdev-hive/core";
import { expandEnv, resolveBin } from "./command.ts";
import { killTree } from "./kill.ts";
import { parseResult } from "./chat.ts";
import { detectRateLimit } from "./rate-limit.ts";
import { ClaudeStream } from "./stream.ts";

export interface AssistHost {
  backend(): HiveBackend;
  actor(): Actor;
  profiles(): AgentProfile[];
  projects(): DesktopProject[];
  machine(): string;
  env(): NodeJS.ProcessEnv;
  unavailable?(profileId: string): boolean;
}

export interface AssistOptions {
  dataDir: string;
  progressMs?: number;
  timeoutMinutes?: number;
}

/** Repo files given to the assistant: at most this many, this big each, this much in all. */
const FILES_MAX = 12;
const FILE_CHARS = 30_000;
const FILES_CHARS = 120_000;

/** Read the repo; nothing else. In -p mode anything not allowed is refused. */
export const assistSettings = () => ({
  disableAllHooks: true,
  permissions: {
    allow: ["Read", "Grep", "Glob"],
    deny: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task"],
  },
});

export const assistBrief = (where: string) =>
  [
    `You are the writing assistant for the docs of ${where} in xDev Hive. You work on one Markdown page.`,
    "Use only the page, the sources given with it, and files of this repository you read (you cannot change them).",
    'Anything you cannot back with a source, mark "(cần xác nhận)" (or "(to be confirmed)" in an English page) instead of guessing.',
    "Write in the page's language, in short full sentences and simple Markdown (#, ##, -, >, code blocks, tables).",
    "Keep [[links]] and images (assets/…) as they are, and the parts you were not asked to change.",
    "Answer exactly in this form and nothing else:",
    "<reply>one or two sentences: what you changed and from which sources</reply>",
    "<markdown>the whole page after your change</markdown>",
    "When the page needs no change (for example a check found nothing), leave <markdown></markdown> empty.",
  ].join(" ");

const KIND_NOTE: Record<DocAssistJob["kind"], string> = {
  draft: "Fill in what the page is missing (or write the whole page when it is empty) from the sources; keep what is there.",
  code: "Bring the page in line with the code: the files listed and the recent commits below.",
  check: "Check the page against the sources (memory, other pages, code). In the reply, name each contradiction; fix only the clear ones in the page.",
  summary: "Rewrite the page as a short version for AGENTS.md (an agent reads it before every task): at most about 15 lines, only what an agent must follow.",
  free: "Do what is asked.",
};

/** A repo glob as a RegExp over repo-relative paths (** any folders, * within one, ? one character). */
export function globRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The files the ask names, read from the repo (tracked files for globs), within the limits. */
export function readRepoFiles(repo: string, wanted: string[]): { files: Array<{ path: string; text: string }>; missing: string[] } {
  const files: Array<{ path: string; text: string }> = [];
  const missing: string[] = [];
  let listed: string[] | null = null;
  const tracked = () => {
    if (listed) return listed;
    try {
      listed = execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\n").filter(Boolean);
    } catch {
      listed = [];
    }
    return listed;
  };
  let room = FILES_CHARS;
  let byteRoom = FILES_CHARS * 4;
  let reads = 0;
  let root: string;
  try {
    root = realpathSync(repo);
  } catch {
    return { files, missing: [...wanted] };
  }
  const inside = (abs: string) => {
    const rel = path.relative(root, abs);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const take = (rel: string) => {
    if (reads >= FILES_MAX || room <= 0 || byteRoom <= 0 || files.some((f) => f.path === rel)) return;
    const abs = path.resolve(root, rel);
    let fd: number | undefined;
    try {
      if (!inside(abs)) throw new Error("Outside repository");
      const resolved = realpathSync(abs);
      if (!inside(resolved)) throw new Error("Outside repository");
      const before = statSync(resolved);
      if (!before.isFile()) throw new Error("Not a regular file");
      reads++;
      // NOFOLLOW closes the final-component race; NONBLOCK avoids hanging if it becomes a FIFO.
      fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("File changed");
      // Linux exposes the opened target, so a swapped parent symlink cannot bypass containment.
      // Elsewhere recheck the path and identity before reading from the already opened descriptor.
      const target = realpathSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : resolved);
      const current = statSync(target);
      if (!inside(target) || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("File changed");
      // UTF-8 needs at most four bytes per character. Never load the full file just to truncate it.
      const raw = Buffer.alloc(Math.min(opened.size, Math.min(FILE_CHARS, room) * 4, byteRoom));
      let length = 0;
      while (length < raw.length) {
        const n = readSync(fd, raw, length, raw.length - length, null);
        if (!n) break;
        length += n;
      }
      byteRoom -= length;
      const bytes = raw.subarray(0, length);
      if (bytes.includes(0)) return;
      const text = bytes.toString("utf8").slice(0, Math.min(FILE_CHARS, room));
      room -= text.length;
      files.push({ path: rel, text });
    } catch {
      missing.push(rel);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  for (const w of wanted) {
    if (/[*?]/.test(w)) {
      const re = globRegExp(w);
      const hits = tracked().filter((f) => re.test(f));
      if (!hits.length) missing.push(w);
      for (const f of hits) take(f);
    } else take(w);
  }
  return { files, missing };
}

/** What goes to Claude on stdin: the ask, the page, the sources, the files and (for "code") the recent commits. */
export function assistInput(job: DocAssistJob, files: Array<{ path: string; text: string }>, missing: string[], commits: string): string {
  const fence = (text: string) => {
    let f = "```";
    while (text.includes(f)) f += "`";
    return f;
  };
  return [
    `# Ask (${job.kind})`,
    job.prompt,
    KIND_NOTE[job.kind],
    "",
    `# The page: ${job.title} (${job.docKey})`,
    "<page>",
    job.base,
    "</page>",
    "",
    "# Sources",
    job.context.trim() || "(none besides the page)",
    ...(files.length || missing.length
      ? ["", "# Repository files", ...files.flatMap((f) => [`## ${f.path}`, `${fence(f.text)}\n${f.text}\n${fence(f.text)}`]), ...(missing.length ? [`Not found: ${missing.join(", ")}`] : [])]
      : []),
    ...(commits ? ["", "# Recent commits", commits] : []),
  ].join("\n");
}

/** The reply and the proposed page out of the answer; no page when it left it empty or unchanged. */
export function parseAssist(text: string, base: string): { reply: string; markdown: string | null } {
  const reply = /<reply>([\s\S]*?)<\/reply>/.exec(text)?.[1]?.trim();
  const md = /<markdown>([\s\S]*?)<\/markdown>/.exec(text)?.[1];
  const page = md?.replace(/^\n+/, "").replace(/\s+$/, "");
  const markdown = page ? `${page}\n` : null;
  return {
    reply: reply || (md === undefined ? text.trim() : ""),
    markdown: markdown && markdown.trim() !== base.trim() ? markdown : null,
  };
}

export class AssistWorker {
  readonly #host: AssistHost;
  readonly #opts: Required<AssistOptions>;
  #job: { id: number; stop: () => void } | null = null;
  #inflight: Promise<void> | null = null;
  /** The hub does not know docs.assistTake yet: it is not asked again. */
  #off = false;

  constructor(host: AssistHost, opts: AssistOptions) {
    this.#host = host;
    this.#opts = { progressMs: 3000, timeoutMinutes: 10, ...opts };
  }

  get busy(): boolean {
    return this.#job !== null;
  }

  /** Takes one ask when there is none being written and a Claude profile can start; true when it took one. */
  async poll(): Promise<boolean> {
    if (this.#off || this.#job || !this.#pick()) return false;
    let job: DocAssistJob | null;
    try {
      job = await this.#host
        .backend()
        .call("docs.assistTake", { projects: this.#host.projects().map((p) => p.name), machine: this.#host.machine() }, this.#host.actor());
    } catch (err) {
      if (/unknown method/i.test(toErrorPayload(err).message)) this.#off = true;
      return false;
    }
    if (!job) return false;
    this.#job = { id: job.id, stop: () => undefined };
    this.#inflight = this.#write(job).finally(() => {
      this.#job = null;
      this.#inflight = null;
    });
    return true;
  }

  async settle(): Promise<void> {
    await this.#inflight;
  }

  stop(): void {
    this.#job?.stop();
  }

  #pick(): AgentProfile | null {
    return (
      this.#host
        .profiles()
        .filter((p) => p.kind === "claude" && p.enabled && !this.#host.unavailable?.(p.id))
        .sort((a, b) => a.priority - b.priority)[0] ?? null
    );
  }

  async #write(job: DocAssistJob): Promise<void> {
    const fail = (error: RunRequestError, profile: string | null = null) => this.#finish(job.id, { status: "failed", reply: "", markdown: null, profile, costUsd: null, error });
    const profile = this.#pick();
    const machine = this.#host.machine();
    if (!profile) return fail({ message: `${machine} has no Claude profile it can start now.`, key: "errors.chatNoClaude", vars: { machine, id: "claude" } });
    const base = this.#host.env();
    const bin = resolveBin(profile.bin, base.PATH ?? "");
    if (!bin) return fail({ message: `"${profile.bin}" is not on PATH.`, key: "runNote.binNotFound", vars: { bin: profile.bin } }, profile.id);
    // A project's page is written in its checkout; a team page in an empty folder of this ask.
    const project = job.project ? this.#host.projects().find((p) => p.name === job.project) : null;
    if (job.project && !project) return fail({ message: `Project ${job.project} is not added to the app.`, key: "errors.projectNotAdded", vars: { project: job.project } }, profile.id);
    const scratch = path.join(this.#opts.dataDir, "runs", `assist-${job.id}`);
    const cwd = project?.repo ?? scratch;
    if (!project) mkdirSync(scratch, { recursive: true });
    const { files, missing } = project ? readRepoFiles(project.repo, job.code) : { files: [], missing: [] };
    let commits = "";
    if (project && job.kind === "code") {
      try {
        commits = execFileSync("git", ["log", "-n", "15", "--date=short", "--format=%h %ad %s", "--stat=120"], { cwd: project.repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).slice(0, 20_000);
      } catch {
        // not a git checkout
      }
    }
    const hostEnv = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("ELECTRON_")));
    const env = { ...hostEnv, ...expandEnv(profile.env), HIVE_AGENT: profile.id, ...(job.project ? { HIVE_PROJECT: job.project } : {}) };
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--settings",
      JSON.stringify(assistSettings()),
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--append-system-prompt",
      assistBrief(job.project ? `project ${job.project}` : "the whole team"),
    ];
    const stream = new ClaudeStream(cwd);
    let steps = "";
    let stderr = "";
    let cancelled = false;
    let timedOut = false;
    try {
      const child = spawnCli(bin, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      if (this.#job) this.#job.stop = () => killTree(child);
      child.stdin.on("error", () => undefined);
      child.stdin.end(assistInput(job, files, missing, commits));
      const out = new StringDecoder("utf8");
      child.stdout.on("data", (chunk: Buffer) => (steps = (steps + stream.push(out.write(chunk))).slice(-20_000)));
      child.stderr.on("data", (chunk: Buffer) => (stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000)));
      const report = async () => {
        try {
          const res = await this.#host.backend().call("docs.assistProgress", { id: job.id }, this.#host.actor());
          if (res.cancelled && !cancelled) {
            cancelled = true;
            killTree(child);
          }
        } catch {
          // The hub is away: the next report tries again.
        }
      };
      const tick = setInterval(() => void report(), this.#opts.progressMs);
      const limit = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.#opts.timeoutMinutes * 60_000);
      const code = await new Promise<number | null>((resolve) => {
        child.on("error", (err) => {
          stderr = `${stderr}${err.message}`;
          resolve(-1);
        });
        child.on("close", (c) => resolve(c));
      });
      clearInterval(tick);
      clearTimeout(limit);
      stream.end();
      if (cancelled) return;
      const result = parseResult(stream.result);
      const text = result?.text ?? stream.lastText ?? "";
      const ok = code === 0 && result !== null && !result.isError && !timedOut;
      if (!ok) {
        const hit = detectRateLimit(`${stderr}\n${steps}`);
        return fail(
          timedOut
            ? { message: `Timed out after ${this.#opts.timeoutMinutes} minutes.`, key: "runNote.timedOut", vars: { minutes: this.#opts.timeoutMinutes } }
            : hit
              ? { message: hit.reason.slice(0, 2000) }
              : { message: stderr.trim().split("\n").at(-1)?.slice(0, 2000) || `Exited with code ${code}.`, ...(stderr.trim() ? {} : { key: "runNote.exited", vars: { code: String(code) } }) },
          profile.id,
        );
      }
      const parsed = parseAssist(text, job.base);
      await this.#finish(job.id, { status: "done", reply: parsed.reply.slice(0, 20_000), markdown: parsed.markdown, profile: profile.id, costUsd: result?.costUsd ?? null, error: null });
    } catch (err) {
      await fail({ message: toErrorPayload(err).message }, profile.id);
    } finally {
      if (!project) rmSync(scratch, { recursive: true, force: true });
    }
  }

  async #finish(id: number, f: { status: "done" | "failed"; reply: string; markdown: string | null; profile: string | null; costUsd: number | null; error: RunRequestError | null }): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.#host.backend().call("docs.assistFinish", { id, ...f }, this.#host.actor());
        return;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "conflict" || code === "not_found" || code === "forbidden") return;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
}
