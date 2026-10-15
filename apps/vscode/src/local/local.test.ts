import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext } from "../../test/vscode-mock.ts";

const ui = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  provider: undefined as { provideTextDocumentContent(uri: { path: string }): string } | undefined,
  opened: [] as string[],
  clipboard: "",
  info: [] as string[],
  errors: [] as string[],
  quickPick: vi.fn(),
  inputBox: vi.fn(),
}));

vi.mock("vscode", async (original) => {
  const api = await original<typeof import("vscode")>();
  class TreeItem {
    description?: string;
    tooltip?: string;
    contextValue?: string;
    command?: unknown;
    label: string;
    collapsibleState: number;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  return {
    ...api,
    UIKind: { Desktop: 1, Web: 2 },
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    env: {
      remoteName: undefined,
      uiKind: 1,
      clipboard: {
        writeText: async (v: string) => {
          ui.clipboard = v;
        },
      },
    },
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => Promise<unknown>) => {
        ui.handlers.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: (id: string, ...args: unknown[]) => ui.handlers.get(id)?.(...args),
    },
    window: {
      ...api.window,
      registerTreeDataProvider: () => ({ dispose() {} }),
      showQuickPick: ui.quickPick,
      showInputBox: ui.inputBox,
      showInformationMessage: async (m: string, ...actions: string[]) => {
        ui.info.push(m);
        return actions[0];
      },
      showErrorMessage: async (m: string) => {
        ui.errors.push(m);
      },
      showTextDocument: async () => undefined,
    },
    workspace: {
      ...api.workspace,
      workspaceFolders: [{ name: "app", uri: { fsPath: "/work/app" } }],
      registerTextDocumentContentProvider: (_scheme: string, provider: typeof ui.provider) => {
        ui.provider = provider;
        return { dispose() {} };
      },
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      openTextDocument: async (uri: { toString(): string }) => {
        ui.opened.push(uri.toString());
        return {};
      },
    },
  };
});

import * as vscode from "vscode";
import { register } from "@/local/index.ts";
import { memoryProjects } from "@/local/memory.ts";
import { formatReport } from "@/local/optimize.ts";
import { MachineTree } from "@/views/machine.ts";
import { settings } from "../../test/vscode-mock.ts";

const PROFILES = {
  profiles: [
    { id: "claude", label: "Claude Code", cli: "claude", supported: true, enabled: true, level: "balanced" },
    { id: "codex", cli: "codex", supported: true, enabled: false },
    { id: "gemini", cli: "gemini", supported: false, enabled: false, reason: "Chưa hỗ trợ" },
  ],
};
const REPORT = {
  days: 7,
  sessions: 5,
  bySource: {},
  split: {
    cutoff: "2026-10-10T00:00:00Z",
    sessionsBefore: 2,
    sessionsAfter: 3,
    before: {
      bySource: {
        "claude/interactive": { sessions: 2, calls: 10, weighted: 50_000, medianPeakContext: 180_000, cacheHit: 0.5 },
      },
    },
    after: {
      bySource: {
        "claude/interactive": { sessions: 3, calls: 10, weighted: 30_000, medianPeakContext: 90_000, cacheHit: 0.8 },
      },
    },
  },
  trimmed: { entries: 4, charsCut: 12_345 },
};
const SCAN = {
  files: [
    { profile: "default", path: "/work/app/CLAUDE.md", name: "CLAUDE.md", kind: "instruction", tokens: 900, flags: [] },
    {
      profile: "default",
      path: "/mem/a.md",
      name: "a.md",
      kind: "memory",
      tokens: 120,
      flags: [{ code: "stale", message: "Cũ" }],
    },
    { profile: "default", path: "/mem/b.md", name: "b.md", kind: "memory", tokens: 80, flags: null },
    { profile: "default", path: "/home/AGENTS.md", name: "AGENTS.md", kind: "instruction", tokens: 50, flags: [] },
  ],
  sessions: [
    {
      profile: "default",
      projectKey: "-work-app",
      projectPath: "/work/app",
      sessionTokens: 1100,
      paths: ["/work/app/CLAUDE.md", "/mem/a.md"],
    },
    {
      profile: "default",
      projectKey: "-work-other",
      projectPath: "/work/other",
      sessionTokens: 80,
      paths: ["/mem/b.md"],
    },
  ],
  warnings: null,
};
const PACK = { markdown: "# Context\n- src/a.ts", files: ["src/a.ts"], tokens: 321 };

// Script sh giả chỉ chạy trên Unix; test Windows bỏ qua.
describe.skipIf(process.platform === "win32")("phần tại máy với hive-worker giả", () => {
  let dir: string;
  const run = (id: string, ...args: unknown[]) => {
    const handler = ui.handlers.get(id);
    if (!handler) throw new Error(`chưa đăng ký ${id}`);
    return handler(...args);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hive-local-"));
    const files: Record<string, unknown> = {
      "optimize-status": PROFILES,
      "optimize-enable": { profiles: PROFILES.profiles },
      "optimize-disable": { profiles: PROFILES.profiles },
      "optimize-report": REPORT,
      "memory-scan": SCAN,
      "context-pack": PACK,
    };
    await mkdir(join(dir, "out"));
    for (const [name, value] of Object.entries(files))
      await writeFile(join(dir, "out", `${name}.json`), JSON.stringify(value));
    const script = join(dir, "hive-worker");
    await writeFile(
      script,
      `#!/bin/sh
d="$(dirname "$0")"
echo "$@" >> "$d/args.log"
[ "$1" = "version" ] && { echo 0.3.0; exit 0; }
[ -f "$d/fail" ] && { echo "không đọc được token hive_pat_abcdefghijklmnop" >&2; exit 1; }
name="$1"; [ -n "$2" ] && case "$2" in -*) ;; *) name="$1-$2";; esac
cat "$d/out/$name.json"
`,
    );
    await chmod(script, 0o755);
    settings.set("xdevHive.binPath", dir);
    ui.handlers.clear();
    ui.opened.length = ui.info.length = ui.errors.length = 0;
    ui.clipboard = "";
    ui.quickPick.mockReset();
    ui.inputBox.mockReset();
    // Phần tại máy không được chạm mạng: bất kỳ lời gọi nào làm test hỏng.
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("không được gọi mạng");
    });
    register(createContext() as never);
  });
  afterEach(async () => {
    settings.delete("xdevHive.binPath");
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const calls = async () =>
    (await readFile(join(dir, "args.log"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter((line) => line && line !== "version --json");

  it("mọi lệnh chạy được mà không gọi fetch", async () => {
    await run("xdevHive.local.optimize.enable", { type: "profile", profile: PROFILES.profiles[1] });
    await run("xdevHive.local.optimize.disable", { type: "profile", profile: PROFILES.profiles[0] });
    await run("xdevHive.local.optimize.report", { type: "profile", profile: PROFILES.profiles[0] });
    await run("xdevHive.local.memory.scan");
    ui.inputBox.mockResolvedValue("  sửa lỗi đăng nhập ");
    await run("xdevHive.local.contextPack.build");
    await run("xdevHive.local.contextPack.copy");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(ui.errors).toEqual([]);
    const log = await calls();
    expect(log).toContain("optimize enable --profile codex --json");
    expect(log).toContain("optimize disable --profile claude --json");
    expect(log).toContain("optimize report --profile claude --days 7 --json");
    expect(log).toContain("memory scan --json");
    expect(log).toContain("context-pack --cwd /work/app --query sửa lỗi đăng nhập --json");
    expect(ui.clipboard).toBe(PACK.markdown);
    expect(ui.opened).toEqual(["xdev-hive-local:/optimize-report-claude.md", "xdev-hive-local:/context-pack.md"]);
    expect(ui.provider?.provideTextDocumentContent({ path: "/context-pack.md" })).toBe(PACK.markdown);
    expect(ui.provider?.provideTextDocumentContent({ path: "/optimize-report-claude.md" })).toContain(
      "| claude/interactive | 3 |",
    );
  });

  it("không có node (Command Palette) thì hỏi gói và chỉ liệt kê gói hợp lệ", async () => {
    ui.quickPick.mockResolvedValue({ description: "codex" });
    await run("xdevHive.local.optimize.enable");
    const offered = ui.quickPick.mock.calls[0]?.[0].map((i: { description: string }) => i.description);
    expect(offered).toEqual(["codex"]);
    expect(await calls()).toContain("optimize enable --profile codex --json");
  });

  it("không hỏi truy vấn rỗng và không gọi hive-worker", async () => {
    ui.inputBox.mockResolvedValue("   ");
    await run("xdevHive.local.contextPack.build");
    await run("xdevHive.local.contextPack.copy");
    expect((await calls()).filter((l) => l.startsWith("context-pack"))).toEqual([]);
    expect(ui.info).toContain("Chưa có context pack để chép.");
  });

  it("hive-worker lỗi thì báo tiếng Việt và che bí mật", async () => {
    await writeFile(join(dir, "fail"), "");
    await run("xdevHive.local.memory.scan");
    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0]).toContain("hive-worker lỗi");
    expect(ui.errors[0]).not.toContain("hive_pat_abcdefghijklmnop");
  });

  it("view liệt kê gói, memory theo workspace và context pack", async () => {
    const tree = new MachineTree({
      workspaces: () => ["/work/app"],
      worker: () => ({ text: "Worker", missing: false }),
    });
    const roots = await tree.getChildren();
    expect(roots.map((n) => (n.type === "section" ? n.id : n.type))).toEqual([
      "worker",
      "optimize",
      "memory",
      "contextPack",
    ]);

    const optimize = await tree.getChildren({ type: "section", id: "optimize" });
    const items = optimize.map((n) => tree.getTreeItem(n));
    expect(items.map((i) => i.contextValue)).toEqual([
      "machine.optimize.on",
      "machine.optimize.off",
      "machine.optimize.unsupported",
    ]);
    expect(items[0]?.description).toBe("đang bật · balanced");

    const projects = await tree.getChildren({ type: "section", id: "memory" });
    expect(projects).toHaveLength(1);
    const first = projects[0];
    if (first?.type !== "project") throw new Error("cần project");
    expect(tree.getTreeItem(first).description).toBe("~1100 token mỗi phiên");
    const files = await tree.getChildren(first);
    expect(files.map((f) => tree.getTreeItem(f).description)).toEqual(["~900", "~120 · Cũ"]);

    expect(
      tree.getTreeItem((await tree.getChildren({ type: "section", id: "contextPack" }))[0] as never).contextValue,
    ).toBeUndefined();
    tree.setPack(PACK);
    const pack = (await tree.getChildren({ type: "section", id: "contextPack" }))[0];
    expect(pack && tree.getTreeItem(pack).contextValue).toBe("machine.contextPack");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("chưa cài hive-worker thì view để trống cho lời mời cài", async () => {
    const tree = new MachineTree({ workspaces: () => [], worker: () => ({ text: "Chưa cài", missing: true }) });
    expect(await tree.getChildren()).toEqual([]);
  });

  it("Restricted Mode không chạy tiến trình", async () => {
    Object.assign(vscode.workspace, { isTrusted: false });
    try {
      await run("xdevHive.local.memory.scan");
      expect(ui.errors).toEqual(["Workspace chưa được tin cậy nên không chạy được hive-worker."]);
      await expect(readFile(join(dir, "args.log"), "utf8")).rejects.toThrow();
    } finally {
      Object.assign(vscode.workspace, { isTrusted: true });
    }
  });
});

describe("định dạng", () => {
  it("báo cáo có hai bảng trước/sau mốc bật", () => {
    const text = formatReport("claude", REPORT);
    expect(text).toContain("Trước khi bật (2026-10-10) · 2");
    expect(text).toContain("| claude/interactive | 2 | 5.000 | 180.000 | 50% |");
    expect(text).toContain("| claude/interactive | 3 | 3.000 | 90.000 | 80% |");
    expect(text).toContain("Đã cắt 12.345 ký tự ở 4 mục.");
  });

  it("memory: không dự án nào khớp workspace thì hiện tất cả, file lẻ vào mục Chung", () => {
    const all = memoryProjects(SCAN, ["/nowhere"]);
    expect(all.map((p) => p.label)).toEqual(["app", "other", ""]);
    expect(all[2]?.files.map((f) => f.name)).toEqual(["AGENTS.md"]);
    expect(memoryProjects(SCAN, ["/work/app/"]).map((p) => p.label)).toEqual(["app"]);
  });
});
