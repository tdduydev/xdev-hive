import type { Breakdown, BreakdownTask } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  addDependency,
  mergeTasks,
  removeDependency,
  setProject,
  splitTask,
  toChecklist,
  waveOf,
} from "./breakdown-edit.ts";

const task = (key: string, over: Partial<BreakdownTask> = {}): BreakdownTask => ({
  sliceKey: key,
  title: `Task ${key}`,
  body: `Thân ${key}`,
  project: "payment-api",
  requirementIds: [],
  checklist: [],
  dependsOn: [],
  files: [],
  parallel: true,
  line: 1,
  ...over,
});

const base: Breakdown = {
  parser: "hive-tasks",
  granularity: "item",
  requirements: ["FR-001", "FR-002"],
  tasks: [
    task("T001", { requirementIds: ["FR-001"] }),
    task("T002", { dependsOn: ["T001"], requirementIds: ["FR-002"] }),
    task("T003", { dependsOn: ["T002"], project: "web-shop" }),
  ],
  waves: [["T001"], ["T002"], ["T003"]],
};

const ok = (r: ReturnType<typeof mergeTasks>) => {
  if (!r.ok) throw new Error(`chu trình ${r.cycle.join(" → ")}`);
  return r.breakdown;
};

describe("breakdown-edit", () => {
  it("gộp: cộng requirement, nối lại phụ thuộc vào task nhận", () => {
    const b = ok(mergeTasks(base, "T002", "T001"));
    expect(b.tasks.map((t) => t.sliceKey)).toEqual(["T001", "T003"]);
    expect(b.tasks[0]?.requirementIds).toEqual(["FR-001", "FR-002"]);
    expect(b.tasks[1]?.dependsOn).toEqual(["T001"]);
    expect(b.waves).toEqual([["T001"], ["T003"]]);
  });

  it("tách: nửa sau checklist thành task mới chạy sau task gốc", () => {
    const withList = {
      ...base,
      tasks: base.tasks.map((t) =>
        t.sliceKey === "T001"
          ? {
              ...t,
              checklist: ["a", "b", "c"].map((id) => ({ id, text: id, requirementIds: id === "c" ? ["FR-009"] : [] })),
            }
          : t,
      ),
    };
    const b = ok(splitTask(withList, "T001"));
    expect(b.tasks.map((t) => t.sliceKey)).toEqual(["T001", "T001-2", "T002", "T003"]);
    expect(b.tasks[0]?.checklist.map((c) => c.id)).toEqual(["a", "b"]);
    expect(b.tasks[1]).toMatchObject({ dependsOn: ["T001"], requirementIds: ["FR-009"] });
    expect(waveOf(b).get("T001-2")).toBe(1);
    expect(splitTask(base, "T003")).toEqual({ ok: true, breakdown: base });
  });

  it("chuyển thành checklist của task khác", () => {
    const b = ok(toChecklist(base, "T003", "T002"));
    expect(b.tasks.map((t) => t.sliceKey)).toEqual(["T001", "T002"]);
    expect(b.tasks[1]?.checklist).toEqual([{ id: "T003", text: "Task T003", requirementIds: [] }]);
  });

  it("thêm phụ thuộc tạo vòng thì từ chối và chỉ ra vòng", () => {
    const r = addDependency(base, "T001", "T003");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cycle).toEqual(expect.arrayContaining(["T001", "T002", "T003"]));
    expect(addDependency(base, "T001", "T001").ok).toBe(false);
  });

  it("bỏ phụ thuộc và đổi dự án tính lại đợt", () => {
    const b = ok(removeDependency(base, "T003", "T002"));
    expect(b.waves).toEqual([["T001", "T003"], ["T002"]]);
    expect(ok(setProject(base, "T001", "web-shop")).tasks[0]?.project).toBe("web-shop");
  });
});
