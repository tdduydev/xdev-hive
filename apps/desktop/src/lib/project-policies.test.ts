import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectPolicies, type PolicyDrift, policyDrift, useProjectPolicies } from "@/lib/hub-context.ts";
import type { OptimizePlan, PlanStep } from "@/lib/optimize-all.ts";

const A = "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11";
const B = "0b9d4f6e-5c1a-4a52-8e0f-3d6a7c1e9b22";
const C = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";

const local = (projectId: string, over: Record<string, unknown> = {}) => ({
  projectId,
  name: `Dự án ${projectId.slice(0, 4)}`,
  folder: `/work/${projectId.slice(0, 4)}`,
  fullPermission: false,
  exists: true,
  isGit: true,
  ...over,
});

const policy = (over: Record<string, unknown> = {}) => ({
  level: "balanced",
  rtk: false,
  codegraph: false,
  autoCompactWindow: null,
  contextBudgetTokens: 2000,
  memoryAutoSync: false,
  memorySyncMinutes: 60,
  ...over,
});

/** `hub_rpc` trả `projects.get`: một id không có trong `hubProjects` là hub lỗi (mất mạng, hết quyền). */
function fakeTauri(locals: unknown[], hubProjects: Record<string, unknown>) {
  const asked: string[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args: Record<string, unknown> = {}) => {
        if (command === "local_projects") return { path: "p", exists: true, imported: 0, projects: locals } as T;
        if (command === "hub_rpc") {
          const query = new URL(`http://hub.local${args.path}`).searchParams.get("data");
          const id = JSON.parse(String(query ?? args.body)).json.id as string;
          asked.push(id);
          const settings = hubProjects[id];
          if (settings === undefined) return { status: 503, contentType: "application/json", body: "{}" } as T;
          return {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ json: { id, settings: { devOptimizer: settings } } }),
          } as T;
        }
        throw new Error(`Lệnh chưa giả: ${command}`);
      },
    },
  };
  return asked;
}

afterEach(() => {
  delete window.__TAURI__;
});

describe("loadProjectPolicies", () => {
  it("đọc devOptimizer của các dự án đã gắn; dự án chưa đặt chính sách không có mặt", async () => {
    fakeTauri([local(A), local(B)], { [A]: policy({ level: "aggressive", rtk: true }), [B]: null });
    const out = await loadProjectPolicies();
    expect(out.policies).toEqual({ [A]: policy({ level: "aggressive", rtk: true }) });
    expect(out.failed).toBe(0);
  });

  it("bỏ qua repo chưa có dự án hub và thư mục đã mất, gọi mỗi dự án một lần", async () => {
    const asked = fakeTauri([local(A), local(A, { folder: "/work/other" }), local(""), local(B, { exists: false })], {
      [A]: policy(),
    });
    const out = await loadProjectPolicies();
    expect(asked).toEqual([A]);
    expect(Object.keys(out.policies)).toEqual([A]);
  });

  it("một dự án lỗi hub không làm mất chính sách của dự án khác, chỉ tính vào failed", async () => {
    fakeTauri([local(A), local(C)], { [A]: policy({ codegraph: true }) });
    const out = await loadProjectPolicies();
    expect(Object.keys(out.policies)).toEqual([A]);
    expect(out.failed).toBe(1);
  });
});

describe("useProjectPolicies", () => {
  it("chưa đăng nhập thì không gọi hub và không có chính sách", async () => {
    const asked = fakeTauri([local(A)], { [A]: policy() });
    const { result } = renderHook(() => useProjectPolicies(false));
    await Promise.resolve();
    expect(asked).toEqual([]);
    expect(result.current).toEqual({ policies: {}, failed: 0 });
  });

  it("đã đăng nhập thì kéo chính sách; ngoài Tauri không ném lỗi", async () => {
    fakeTauri([local(A)], { [A]: policy({ rtk: true }) });
    const { result, unmount } = renderHook(() => useProjectPolicies(true));
    await waitFor(() => expect(Object.keys(result.current.policies)).toEqual([A]));
    unmount();
    delete window.__TAURI__;
    const bare = renderHook(() => useProjectPolicies(true));
    await Promise.resolve();
    expect(bare.result.current).toEqual({ policies: {}, failed: 0 });
  });
});

const step = (over: Partial<PlanStep>): PlanStep => ({
  id: "optimizer.enable",
  group: "cli",
  target: "claude-2",
  title: "Bật tối ưu",
  changes: [],
  selected: true,
  requiresConfirm: false,
  undoable: true,
  reason: "Theo chính sách dự án Acme Web",
  ...over,
});
const planOf = (...steps: PlanStep[]): OptimizePlan => ({
  createdAt: "2026-10-23T09:00:00Z",
  scoreBefore: 50,
  policySources: [A],
  steps,
});
const items = (drift: PolicyDrift[]) => drift.map((d) => d.item);

describe("policyDrift", () => {
  it("máy đã khớp: kế hoạch chỉ còn bước mặc định thì không lệch", () => {
    const plan = planOf(
      step({ id: "context.sync", group: "context", reason: "Mặc định" }),
      step({ id: "score.recompute", group: "score", reason: "Mặc định" }),
      step({ id: "optimizer.enable", reason: "Mặc định" }),
    );
    expect(policyDrift(plan)).toEqual([]);
  });

  it("gọi tên từng mục lệch kèm dự án đòi mục đó", () => {
    const plan = planOf(
      step({ changes: [{ file: "s.json", key: "level", before: null, after: "balanced" }] }),
      step({ id: "fix.optimizer.rtk", reason: "Theo chính sách dự án Acme Web" }),
      step({ id: "tool.codegraph", group: "tools", reason: "Theo chính sách dự án Acme Api" }),
      step({ id: "context.sync", group: "context" }),
    );
    expect(policyDrift(plan)).toEqual([
      { item: "level", reason: "Theo chính sách dự án Acme Web" },
      { item: "rtk", reason: "Theo chính sách dự án Acme Web" },
      { item: "codegraph", reason: "Theo chính sách dự án Acme Api" },
    ]);
  });

  it("trần nén chỉ lệch khi bước đổi khoá nén; nhiều gói cùng lệch một mục thì gộp một dòng", () => {
    const window = { file: "s.json", key: "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW", before: null, after: "150000" };
    const codex = { file: "c.toml", key: "codex.model_auto_compact_token_limit", before: null, after: "150000" };
    const plan = planOf(
      step({ target: "claude-2", changes: [window] }),
      step({ target: "codex-2", changes: [codex] }),
      step({ target: "claude-3", changes: [] }),
    );
    expect(items(policyDrift(plan))).toEqual(["level", "compact"]);
  });

  it("mức aggressive chưa chọn sẵn vẫn là một chỗ lệch", () => {
    const plan = planOf(step({ level: "aggressive", selected: false, requiresConfirm: true }));
    expect(items(policyDrift(plan))).toEqual(["level"]);
  });

  it("codegraph.init của dự án cũng tính là lệch codegraph", () => {
    const plan = planOf(step({ id: "fix.codegraph.init", group: "tools", project: "app" }));
    expect(items(policyDrift(plan))).toEqual(["codegraph"]);
  });
});
