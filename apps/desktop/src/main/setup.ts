// What is installed on this machine (agent CLIs, the hive-mcp shim) and in each project repo
// (Hive's agent config, codegraph, superpowers), and how to install what is missing.
// No Electron imports: the main process provides a SetupHost, tests provide a fake one.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { HiveError, type AgentKind, type DesktopProject, type FileAction, type SetupInstallResult, type SetupItem, type SetupReport } from "@xdev-hive/core";
import {
  CODEGRAPH_PACKAGE,
  enableSuperpowers,
  installAgents,
  installCodegraphMcp,
  installShim,
  shimStatus,
  type ShimOptions,
} from "./installer.ts";
import { resolveBin } from "./runner/command.ts";

export interface RunResult {
  ok: boolean;
  output: string;
}

export type Run = (bin: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<RunResult>;

export interface SetupHost {
  /** Login-shell PATH; refresh=true after an install may have changed it. */
  pathEnv(refresh?: boolean): string;
  /** Base env for child processes (already carries pathEnv). */
  env(): NodeJS.ProcessEnv;
  projects(): DesktopProject[];
  shim: ShimOptions;
  /** For ~/.codex/config.toml in the agent config check. */
  home?: string;
  run?: Run;
}

/** The CLIs the default profiles use, and the npm package that provides each. */
export const AGENT_CLIS: Array<{ kind: Exclude<AgentKind, "custom">; bin: string; label: string; pkg: string }> = [
  { kind: "claude", bin: "claude", label: "Claude Code", pkg: "@anthropic-ai/claude-code" },
  { kind: "codex", bin: "codex", label: "Codex CLI", pkg: "@openai/codex" },
  { kind: "gemini", bin: "gemini", label: "Gemini CLI", pkg: "@google/gemini-cli" },
];

const OUTPUT_TAIL = 6000;
const tail = (s: string) => (s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s);
const firstLine = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";
const NO_NPM = "Máy chưa có npm: cài Node.js (https://nodejs.org) rồi bấm Kiểm tra lại";

export const defaultRun: Run = (bin, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(bin, args, { cwd, env, timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, output: output || (err ? err.message : "") });
    });
  });

const describeFiles = (files: FileAction[]) =>
  files.map((f) => `${f.action.padEnd(9)} ${f.file}${f.note ? ` · ${f.note}` : ""}`).join("\n");

export class Setup {
  readonly #host: SetupHost;
  readonly #run: Run;

  constructor(host: SetupHost) {
    this.#host = host;
    this.#run = host.run ?? defaultRun;
  }

  async status(): Promise<SetupReport> {
    const pathEnv = this.#host.pathEnv(true);
    const clis = await Promise.all(AGENT_CLIS.map((c) => this.#cli(c, pathEnv)));
    return {
      machine: [...clis, this.#shim(pathEnv)],
      projects: this.#host.projects().map((p) => ({ project: p.name, repo: p.repo, items: this.#projectItems(p, pathEnv) })),
    };
  }

  async item(id: string): Promise<SetupItem> {
    const pathEnv = this.#host.pathEnv(true);
    if (id === "shim") return this.#shim(pathEnv);
    const cli = AGENT_CLIS.find((c) => id === `cli:${c.kind}`);
    if (cli) return this.#cli(cli, pathEnv);
    const { project, part } = this.#split(id);
    const item = this.#projectItems(project, pathEnv).find((i) => i.id === `${project.name}:${part}`);
    if (!item) throw new HiveError("not_found", `Không có mục ${id}.`);
    return item;
  }

  async install(id: string): Promise<SetupInstallResult> {
    const pathEnv = this.#host.pathEnv(true);
    const env = { ...this.#host.env(), PATH: pathEnv };
    let output: string;
    const cli = AGENT_CLIS.find((c) => id === `cli:${c.kind}`);
    if (cli) {
      const npm = resolveBin("npm", pathEnv);
      if (!npm) throw new HiveError("bad_request", NO_NPM);
      const r = await this.#run(npm, ["install", "-g", cli.pkg], { env, timeoutMs: 15 * 60_000 });
      if (!r.ok) throw new HiveError("bad_request", `npm install -g ${cli.pkg} lỗi:\n${tail(r.output)}`);
      output = tail(r.output);
    } else if (id === "shim") {
      const r = installShim(this.#host.shim, pathEnv);
      output = `Đã cài ${r.path}`;
    } else {
      const { project, part } = this.#split(id);
      if (part === "agents") output = describeFiles(installAgents(project.repo, project.name, { home: this.#host.home }));
      else if (part === "codegraph-mcp") output = describeFiles([installCodegraphMcp(project.repo)]);
      else if (part === "superpowers") output = describeFiles([enableSuperpowers(project.repo)]);
      else if (part === "codegraph-index") output = await this.#codegraphIndex(project, pathEnv, env);
      else throw new HiveError("not_found", `Không có mục ${id}.`);
    }
    return { item: await this.item(id), output };
  }

  // ── items ──────────────────────────────────────────────────────────────────

  async #cli(cli: (typeof AGENT_CLIS)[number], pathEnv: string): Promise<SetupItem> {
    const base = { id: `cli:${cli.kind}`, label: cli.label };
    const bin = resolveBin(cli.bin, pathEnv);
    if (!bin) {
      const npm = resolveBin("npm", pathEnv);
      return {
        ...base,
        state: "missing",
        detail: npm ? `Chưa cài. Nút Cài chạy: npm install -g ${cli.pkg}` : `Chưa cài. ${NO_NPM}`,
        action: npm ? "Cài bằng npm" : null,
      };
    }
    const v = await this.#run(bin, ["--version"], { env: { ...this.#host.env(), PATH: pathEnv }, timeoutMs: 15_000 });
    return {
      ...base,
      state: "installed",
      detail: v.ok ? `${firstLine(v.output) || "?"} · ${bin}` : `${bin} · --version lỗi: ${firstLine(v.output)}`,
      action: null,
    };
  }

  #shim(pathEnv: string): SetupItem {
    const s = shimStatus(this.#host.shim, pathEnv);
    const base = { id: "shim", label: "Lệnh hive-mcp" };
    const dir = path.dirname(s.path);
    if (s.foreign) return { ...base, state: "manual", detail: `${s.path} là file khác, không do Hive cài. Đổi tên hoặc xoá nó rồi cài lại.`, action: null };
    if (s.state === "missing") return { ...base, state: "missing", detail: "Chưa cài. Agent cần lệnh này để gọi Hive qua MCP.", action: "Cài" };
    if (s.state === "outdated") return { ...base, state: "outdated", detail: `${s.path} đang trỏ tới bản app khác.`, action: "Cài lại cho bản này" };
    if (!s.onPath) {
      return { ...base, state: "manual", detail: `${s.path}, nhưng ${dir} chưa có trong PATH của shell. Thêm export PATH="${dir}:$PATH" vào ~/.zshrc.`, action: null };
    }
    return { ...base, state: "installed", detail: s.path, action: null };
  }

  #projectItems(project: DesktopProject, pathEnv: string): SetupItem[] {
    const id = (part: string) => `${project.name}:${part}`;
    if (!existsSync(project.repo)) {
      return [{ id: id("agents"), label: "Cấu hình agent", state: "manual", detail: `Không thấy thư mục ${project.repo}`, action: null }];
    }
    const plan = installAgents(project.repo, project.name, { home: this.#host.home, dryRun: true });
    const changes = plan.filter((f) => f.action === "created" || f.action === "updated");
    const manual = plan.filter((f) => f.action === "skipped");
    const agents: SetupItem = changes.length
      ? { id: id("agents"), label: "Cấu hình agent", state: "missing", detail: `Cần ghi: ${changes.map((f) => f.file).join(", ")}`, action: "Cài vào agents" }
      : manual.length
        ? { id: id("agents"), label: "Cấu hình agent", state: "manual", detail: manual.map((f) => `${f.file}: ${f.note}`).join(" · "), action: null }
        : { id: id("agents"), label: "Cấu hình agent", state: "installed", detail: "MCP xdev-hive cho Claude Code, Gemini, Codex · hook chặn sửa tài liệu · pre-commit", action: null };

    const mcp = installCodegraphMcp(project.repo, { dryRun: true });
    const codegraphMcp: SetupItem =
      mcp.action === "unchanged"
        ? { id: id("codegraph-mcp"), label: "codegraph (MCP)", state: "installed", detail: "Có trong .mcp.json", action: null }
        : mcp.action === "skipped"
          ? { id: id("codegraph-mcp"), label: "codegraph (MCP)", state: "manual", detail: `.mcp.json: ${mcp.note}`, action: null }
          : { id: id("codegraph-mcp"), label: "codegraph (MCP)", state: "missing", detail: `Chưa có trong .mcp.json (${CODEGRAPH_PACKAGE}, tắt telemetry)`, action: "Thêm vào .mcp.json" };

    const db = path.join(project.repo, ".codegraph", "codegraph.db");
    const npx = resolveBin("npx", pathEnv);
    const index: SetupItem = existsSync(db)
      ? {
          id: id("codegraph-index"),
          label: "Index codegraph",
          state: "installed",
          detail: `.codegraph/ · ${(statSync(db).size / 1_048_576).toFixed(1)} MB, tự cập nhật khi MCP server chạy`,
          action: null,
        }
      : {
          id: id("codegraph-index"),
          label: "Index codegraph",
          state: "missing",
          detail: npx ? "Chưa tạo. Lần đầu npm tải gói codegraph cho nền tảng (~290 MB trên macOS arm64)." : `Chưa tạo. ${NO_NPM}`,
          action: npx ? "Tạo index" : null,
        };

    const sp = enableSuperpowers(project.repo, { dryRun: true });
    const superpowers: SetupItem =
      sp.action === "unchanged"
        ? { id: id("superpowers"), label: "superpowers (plugin)", state: "installed", detail: "Bật trong .claude/settings.json", action: null }
        : sp.action === "skipped"
          ? { id: id("superpowers"), label: "superpowers (plugin)", state: "manual", detail: `.claude/settings.json: ${sp.note}`, action: null }
          : {
              id: id("superpowers"),
              label: "superpowers (plugin)",
              state: "missing",
              detail: "Chưa bật. Sau khi bật, Claude Code hỏi cài plugin ở lần mở repo kế tiếp.",
              action: "Bật",
            };

    return [agents, codegraphMcp, index, superpowers];
  }

  async #codegraphIndex(project: DesktopProject, pathEnv: string, env: NodeJS.ProcessEnv): Promise<string> {
    const npx = resolveBin("npx", pathEnv);
    if (!npx) throw new HiveError("bad_request", NO_NPM);
    const opts = { cwd: project.repo, env: { ...env, CODEGRAPH_TELEMETRY: "0" }, timeoutMs: 20 * 60_000 };
    // Opt this machine out first: codegraph sends anonymous usage stats by default.
    const off = await this.#run(npx, ["-y", CODEGRAPH_PACKAGE, "telemetry", "off"], opts);
    if (!off.ok) throw new HiveError("bad_request", `codegraph telemetry off lỗi:\n${tail(off.output)}`);
    const init = await this.#run(npx, ["-y", CODEGRAPH_PACKAGE, "init"], opts);
    if (!init.ok) throw new HiveError("bad_request", `codegraph init lỗi:\n${tail(init.output)}`);
    return tail(`${off.output}\n${init.output}`.trim());
  }

  #split(id: string): { project: DesktopProject; part: string } {
    const at = id.lastIndexOf(":");
    const name = id.slice(0, at);
    const project = this.#host.projects().find((p) => p.name === name);
    if (at < 1 || !project) throw new HiveError("not_found", `Không có mục ${id}.`);
    return { project, part: id.slice(at + 1) };
  }
}
