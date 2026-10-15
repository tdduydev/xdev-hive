import { SDLC_GATE_BLOCKED, SDLC_PRESETS, type SdlcMode, sdlcMode, TASK_DEPENDENCIES_OPEN } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  activeOverride,
  evaluateGate,
  type GateArtifact,
  type GateInput,
  type GateOverride,
  type GatePhase,
  missingArtifacts,
  strictestBlocking,
} from "./gate.ts";

const NOW = new Date("2026-10-14T00:00:00Z");
const HOUR = 3_600_000;
const WEB = { id: "p-web", key: "web-shop" };
const API = { id: "p-api", key: "api" };

const speckit = SDLC_PRESETS.speckit as SdlcMode;
/** Speckit thêm một tài liệu bắt buộc riêng cho từng dự án ở giai đoạn Plan. */
const mode: SdlcMode = sdlcMode.parse({
  ...speckit,
  phases: speckit.phases.map((p) =>
    p.id === "plan"
      ? {
          ...p,
          artifacts: [
            ...p.artifacts,
            { id: "notes", name: "notes.md", path: "specs/{NNN}-{slug}/notes.md", scope: "project" },
          ],
        }
      : p,
  ),
});
const item = { number: 12, slug: "hoan-tien", mode };

const phases: GatePhase[] = mode.phases.map((p, phaseIndex) => ({
  phaseIndex,
  phaseId: p.id,
  kind: p.kind,
  status: "pending",
}));

const row = (phaseId: string, artifactId: string, over: Partial<GateArtifact> = {}): GateArtifact => ({
  phaseId,
  artifactId,
  required: true,
  scope: "item",
  instance: "",
  projectId: WEB.id,
  consumerProjectIds: [],
  docKey: `project/web-shop/sdlc/012-hoan-tien/${artifactId}`,
  baselineVersion: 1,
  approval: "human",
  ...over,
});
const approved = (): GateArtifact[] => [
  row("specify", "spec"),
  row("plan", "plan"),
  row("plan", "notes", { scope: "project", instance: WEB.key }),
  row("tasks", "tasks"),
];
const missing = (artifacts: GateArtifact[], over: Partial<Parameters<typeof missingArtifacts>[0]> = {}) =>
  missingArtifacts({ item, homeKey: WEB.key, project: WEB, phases, artifacts, ...over });
const names = (artifacts: GateArtifact[], over?: Parameters<typeof missing>[1]) =>
  missing(artifacts, over).map((m) => m.name);

describe("strictestBlocking", () => {
  it("lấy mức chặt nhất của chế độ và cài đặt dự án", () => {
    expect(strictestBlocking("soft", "hard")).toBe("hard");
    expect(strictestBlocking("none", "soft", undefined)).toBe("soft");
    expect(strictestBlocking("hard", "none", null)).toBe("hard");
    expect(strictestBlocking("none", "none")).toBe("none");
  });

  it("không mức nào khai thì chặn cứng", () => {
    expect(strictestBlocking(undefined, null)).toBe("hard");
  });
});

describe("activeOverride", () => {
  const o = (over: Partial<GateOverride> & { id: string }): GateOverride => ({
    taskId: null,
    projectId: null,
    expiresAt: null,
    revokedAt: null,
    ...over,
  });
  const scope = { taskId: "t1", projectId: WEB.id };

  it("phạm vi task, dự án và hạng mục đều phủ task; phạm vi khác thì không", () => {
    expect(activeOverride([o({ id: "a", taskId: "t1" })], scope, NOW)?.id).toBe("a");
    expect(activeOverride([o({ id: "b", projectId: WEB.id })], scope, NOW)?.id).toBe("b");
    expect(activeOverride([o({ id: "c" })], scope, NOW)?.id).toBe("c");
    expect(activeOverride([o({ id: "d", taskId: "t2" }), o({ id: "e", projectId: API.id })], scope, NOW)).toBeNull();
  });

  it("phạm vi hẹp nhất thắng", () => {
    const all = [o({ id: "item" }), o({ id: "project", projectId: WEB.id }), o({ id: "task", taskId: "t1" })];
    expect(activeOverride(all, scope, NOW)?.id).toBe("task");
    expect(activeOverride(all.slice(0, 2), scope, NOW)?.id).toBe("project");
  });

  it("hết hạn hoặc đã thu hồi thì không tính; đúng lúc hết hạn cũng hết", () => {
    expect(activeOverride([o({ id: "a", expiresAt: new Date(NOW.getTime() - HOUR) })], scope, NOW)).toBeNull();
    expect(activeOverride([o({ id: "a", expiresAt: NOW })], scope, NOW)).toBeNull();
    expect(activeOverride([o({ id: "a", expiresAt: new Date(NOW.getTime() + HOUR) })], scope, NOW)?.id).toBe("a");
    expect(activeOverride([o({ id: "a", revokedAt: NOW })], scope, NOW)).toBeNull();
  });

  it("ngoại lệ hết hạn không che ngoại lệ còn hạn", () => {
    const list = [o({ id: "old", taskId: "t1", expiresAt: new Date(NOW.getTime() - HOUR) }), o({ id: "all" })];
    expect(activeOverride(list, scope, NOW)?.id).toBe("all");
  });
});

describe("missingArtifacts", () => {
  it("đủ baseline thì không thiếu; tài liệu tuỳ chọn và giai đoạn sau implementation không tính", () => {
    expect(missing(approved())).toEqual([]);
  });

  it("liệt kê tài liệu bắt buộc chưa có baseline, kèm tên giai đoạn", () => {
    const rows = approved().map((r) => (r.artifactId === "plan" ? { ...r, baselineVersion: null } : r));
    expect(missing(rows)).toEqual([
      {
        kind: "artifact",
        docKey: "project/web-shop/sdlc/012-hoan-tien/plan",
        name: "plan.md (Plan)",
        phase: "Plan",
        reason: "no_baseline",
      },
    ]);
  });

  it("approval = revoked coi như chưa có baseline và báo riêng lý do", () => {
    const rows = approved().map((r) => (r.artifactId === "spec" ? { ...r, approval: "revoked" as const } : r));
    expect(missing(rows)).toMatchObject([{ name: "spec.md (Specify)", reason: "revoked" }]);
  });

  it("duyệt lại sau thu hồi (reaffirmed) và tự duyệt đều là có baseline", () => {
    const rows = approved().map((r) =>
      r.artifactId === "spec" ? { ...r, approval: "reaffirmed" as const } : { ...r, approval: "auto" as const },
    );
    expect(missing(rows)).toEqual([]);
  });

  it("dòng chưa được tạo vẫn tính là thiếu, docKey suy từ chế độ", () => {
    const rows = approved().filter((r) => r.artifactId !== "tasks");
    expect(missing(rows)).toEqual([
      {
        kind: "artifact",
        docKey: "project/web-shop/sdlc/012-hoan-tien/tasks",
        name: "tasks.md (Tasks)",
        phase: "Tasks",
        reason: "no_baseline",
      },
    ]);
  });

  it("giai đoạn skipped không tính", () => {
    const skipped = phases.map((p) => (p.phaseId === "plan" ? { ...p, status: "skipped" } : p));
    expect(names([row("specify", "spec"), row("tasks", "tasks")], { phases: skipped })).toEqual([]);
  });

  it("chỉ xét giai đoạn đứng trước implementation", () => {
    // Implement đứng thứ hai: chỉ Specify còn trước nó, Plan và Tasks là giai đoạn sau.
    const order = ["specify", "implement", "plan", "tasks", "converge"];
    const reordered = order.map((id, phaseIndex) => ({
      ...(phases.find((p) => p.phaseId === id) as GatePhase),
      phaseIndex,
    }));
    expect(names([], { phases: reordered })).toEqual(["spec.md (Specify)"]);
  });

  it("mode không có giai đoạn implementation thì xét mọi giai đoạn", () => {
    const noImpl = phases.filter((p) => p.kind !== "implementation");
    expect(names([], { phases: noImpl })).toEqual([
      "spec.md (Specify)",
      "plan.md (Plan)",
      "notes.md (Plan)",
      "tasks.md (Tasks)",
      "release-notes.md (Release)",
      "retro.md (Release)",
    ]);
  });

  it("tài liệu riêng chỉ tính của chính dự án", () => {
    const rows = approved().filter((r) => r.artifactId !== "notes");
    expect(names(rows)).toEqual(["notes.md (Plan)"]);
    // Dự án api có tài liệu notes riêng nên không bị thiếu bởi dòng của web-shop; tài liệu chung vẫn dùng chung.
    const withApi = [...rows, row("plan", "notes", { scope: "project", instance: API.key, projectId: API.id })];
    expect(names(withApi, { project: API })).toEqual([]);
    expect(names(withApi, { project: WEB })).toEqual(["notes.md (Plan)"]);
  });

  it("docKey của tài liệu riêng dự án khác đi vào thư mục dự án đó", () => {
    expect(
      missing(
        approved().filter((r) => r.artifactId !== "notes"),
        { project: API },
      ).map((m) => m.docKey),
    ).toEqual(["project/api/sdlc/web-shop-012-hoan-tien/notes"]);
  });

  describe("contract", () => {
    const contract = (over: Partial<GateArtifact> = {}) =>
      row("plan", "contract", {
        scope: "contract",
        instance: "refund-api",
        projectId: API.id,
        consumerProjectIds: [WEB.id],
        baselineVersion: null,
        approval: "none",
        docKey: "project/web-shop/sdlc/012-hoan-tien/contracts/refund-api",
        ...over,
      });
    const apiDocs = [
      row("specify", "spec"),
      row("plan", "plan"),
      row("plan", "notes", { scope: "project", instance: API.key, projectId: API.id }),
      row("tasks", "tasks"),
    ];

    it("contract chưa duyệt chặn bên cung cấp và bên dùng", () => {
      expect(names([...apiDocs, contract()], { project: API })).toEqual(["contract refund-api"]);
      expect(names([...approved(), contract()], { project: WEB })).toEqual(["contract refund-api"]);
    });

    it("không chặn dự án không liên quan", () => {
      const other = { id: "p-crm", key: "crm" };
      const docs = apiDocs.map((r) => (r.artifactId === "notes" ? { ...r, instance: other.key } : r));
      expect(names([...docs, contract()], { project: other })).toEqual([]);
    });

    it("contract đã duyệt thì hết chặn; contract không bắt buộc thì không tính", () => {
      expect(names([...approved(), contract({ baselineVersion: 2 })], { project: WEB })).toEqual([]);
      expect(names([...approved(), contract({ required: false })], { project: WEB })).toEqual([]);
    });

    it("contract bị thu hồi tự duyệt chặn lại", () => {
      const revoked = contract({ baselineVersion: 2, approval: "revoked" });
      expect(missing([...approved(), revoked], { project: WEB })).toMatchObject([
        { name: "contract refund-api", reason: "revoked" },
      ]);
    });
  });
});

describe("evaluateGate", () => {
  const gateInput = (over: Partial<GateInput> = {}): GateInput => ({
    itemId: "item-1",
    taskId: "t1",
    project: WEB,
    projectActive: true,
    blocking: "hard",
    openDependencies: [],
    missing: [],
    overrides: [],
    now: NOW,
    ...over,
  });
  const doc = (reason: "no_baseline" | "revoked" = "no_baseline") =>
    ({ kind: "artifact", docKey: "k", name: "plan.md (Plan)", phase: "Plan", reason }) as const;
  const override = (over: Partial<GateOverride> = {}): GateOverride => ({
    id: "ov-1",
    taskId: null,
    projectId: null,
    expiresAt: null,
    revokedAt: null,
    ...over,
  });

  it("đủ tài liệu và không phụ thuộc thì cho qua", () => {
    expect(evaluateGate(gateInput())).toEqual({ block: false, itemId: "item-1" });
  });

  it("hard: chặn, liệt kê tài liệu thiếu", () => {
    const r = evaluateGate(gateInput({ missing: [doc()] }));
    expect(r).toMatchObject({ block: true, code: SDLC_GATE_BLOCKED, itemId: "item-1", missing: [doc()] });
    expect(r.block && r.message).toContain("plan.md (Plan) chưa duyệt");
  });

  it("hard: tài liệu bị thu hồi tự duyệt nói rõ đang duyệt lại", () => {
    const r = evaluateGate(gateInput({ missing: [doc("revoked")] }));
    expect(r.block && r.message).toContain("đang duyệt lại sau khi thu hồi tự duyệt");
  });

  it("soft: cho chạy kèm cảnh báo", () => {
    const r = evaluateGate(gateInput({ blocking: "soft", missing: [doc()] }));
    expect(r).toMatchObject({ block: false });
    expect(!r.block && r.warn).toContain("plan.md (Plan) chưa duyệt");
  });

  it("none: không kiểm tài liệu và không cảnh báo", () => {
    expect(evaluateGate(gateInput({ blocking: "none", missing: [doc()] }))).toEqual({ block: false, itemId: "item-1" });
  });

  it("phụ thuộc chưa done chặn dù mức none hay soft", () => {
    const dep = { taskId: "t0", key: "WEB-3", status: "todo" };
    for (const blocking of ["none", "soft", "hard"] as const) {
      const r = evaluateGate(gateInput({ blocking, openDependencies: [dep] }));
      expect(r).toMatchObject({
        block: true,
        code: TASK_DEPENDENCIES_OPEN,
        missing: [{ kind: "dependency", ...dep }],
      });
    }
  });

  it("vừa thiếu tài liệu vừa chờ phụ thuộc: báo cả hai, mã là phụ thuộc", () => {
    const dep = { taskId: "t0", key: "WEB-3", status: "todo" };
    const r = evaluateGate(gateInput({ openDependencies: [dep], missing: [doc()] }));
    expect(r).toMatchObject({ block: true, code: TASK_DEPENDENCIES_OPEN });
    expect(r.block && r.missing.map((m) => m.kind)).toEqual(["dependency", "artifact"]);
  });

  it("ngoại lệ còn hiệu lực cho qua và trả id để engine ghi sự kiện", () => {
    const r = evaluateGate(gateInput({ missing: [doc()], overrides: [override()] }));
    expect(r).toEqual({ block: false, itemId: "item-1", overrideId: "ov-1" });
    const dep = { taskId: "t0", key: "WEB-3", status: "todo" };
    expect(evaluateGate(gateInput({ openDependencies: [dep], overrides: [override({ taskId: "t1" })] }))).toMatchObject(
      {
        block: false,
        overrideId: "ov-1",
      },
    );
  });

  it("ngoại lệ hết hạn, đã thu hồi hoặc của task khác thì vẫn chặn", () => {
    const expired = override({ expiresAt: new Date(NOW.getTime() - HOUR) });
    const revoked = override({ revokedAt: NOW });
    const other = override({ taskId: "t2" });
    expect(evaluateGate(gateInput({ missing: [doc()], overrides: [expired, revoked, other] })).block).toBe(true);
  });

  it("không có gì chặn thì không báo đã dùng ngoại lệ", () => {
    expect(evaluateGate(gateInput({ overrides: [override()] }))).toEqual({ block: false, itemId: "item-1" });
  });

  it("dự án đã bỏ hoặc tắt AI SDLC chặn và không ngoại lệ nào mở được", () => {
    const r = evaluateGate(gateInput({ projectActive: false, overrides: [override()] }));
    expect(r).toMatchObject({
      block: true,
      code: SDLC_GATE_BLOCKED,
      message: "Dự án web-shop đã tắt AI SDLC.",
      missing: [{ kind: "project", projectId: WEB.id, key: WEB.key }],
    });
  });
});
