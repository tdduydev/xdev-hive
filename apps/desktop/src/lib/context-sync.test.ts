import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type ContextProject,
  type ContextTargetId,
  contextDisable,
  contextEnable,
  contextMigrate,
  contextResolve,
  contextSaveSource,
  contextStatus,
  contextSync,
  isContextProject,
} from "@/lib/context-sync.ts";

// Fixture do worker Go sinh ra: kiểu TS phải đọc được đúng file này.
const fixture: unknown = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../worker/internal/ctxsync/testdata/context-project.json"), "utf8"),
);

describe("kiểu ContextProject", () => {
  it("khớp fixture của worker Go", () => {
    expect(isContextProject(fixture)).toBe(true);
    const project = fixture as ContextProject;
    const ids: ContextTargetId[] = project.targets.map((t) => t.id);
    expect(ids).toEqual(["claude", "codex", "gemini", "antigravity"]);
    expect(project.targets.find((t) => t.status === "conflict")?.conflict?.source).toBe("# Nguồn\n");
    expect(project.hub?.omitted).toEqual({ budget: 2, secret: 1 });
    expect(project.autoSync.source).toBe("policy");
    expect(project.locked).toBe(true);
  });

  it("từ chối dữ liệu sai hình", () => {
    expect(isContextProject(null)).toBe(false);
    expect(isContextProject({ ...(fixture as object), targets: "x" })).toBe(false);
    expect(isContextProject({ ...(fixture as object), enabled: "yes" })).toBe(false);
  });
});

describe("cầu nối ngữ cảnh dùng chung", () => {
  it("gửi đúng lệnh và tham số Tauri", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    window.__TAURI__ = { core: { invoke } };
    const hub = { projectId: "p", items: [] };
    await contextStatus();
    await contextStatus("p_1");
    await contextEnable("/work/app", "id-1");
    await contextEnable("/work/app");
    await contextDisable("p_1");
    await contextSaveSource("p_1", "# Nguồn\n");
    await contextSync("p_1", hub, null);
    await contextSync("p_1");
    await contextResolve("p_1", "gemini", "file");
    await contextMigrate("p_1", true);
    await contextMigrate("p_1");
    expect(invoke.mock.calls).toEqual([
      ["context_status", { project: null }],
      ["context_status", { project: "p_1" }],
      ["context_enable", { folder: "/work/app", projectId: "id-1" }],
      ["context_enable", { folder: "/work/app", projectId: null }],
      ["context_disable", { project: "p_1" }],
      ["context_save_source", { project: "p_1", content: "# Nguồn\n" }],
      ["context_sync", { project: "p_1", hub, policy: null }],
      ["context_sync", { project: "p_1", hub: null, policy: null }],
      ["context_resolve", { project: "p_1", target: "gemini", keep: "file" }],
      ["context_migrate", { project: "p_1", apply: true }],
      ["context_migrate", { project: "p_1", apply: false }],
    ]);
  });

  it("giữ lỗi tiếng Việt do sidecar trả về", async () => {
    window.__TAURI__ = { core: { invoke: vi.fn().mockRejectedValue("Khoá dự án không hợp lệ.") } };
    await expect(contextSync("x")).rejects.toBe("Khoá dự án không hợp lệ.");
  });
});
