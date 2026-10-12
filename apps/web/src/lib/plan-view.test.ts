import type { Plan, PlanContent } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import {
  canDecidePlan,
  effectiveContent,
  fromDraft,
  move,
  type PlanDraft,
  planStage,
  sameContent,
  toDraft,
} from "@/lib/plan-view.ts";
import { makeRun, makeTask } from "@/lib/test-fixtures.ts";

const content: PlanContent = {
  summary: "Làm tròn theo đồng.",
  steps: [{ title: "Sửa round()", detail: "Dùng Math.round" }, { title: "Thêm test" }],
  files: [{ path: "src/vat.ts", change: "modify", reason: "Hàm làm tròn" }, { path: "src/vat.test.ts" }],
  risks: ["Hoá đơn cũ lệch 1 đồng"],
  questions: ["Có làm tròn từng dòng không?"],
};

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "p1",
  taskId: "t1",
  runId: "r1",
  planRunId: "r2",
  revision: 1,
  status: "awaiting",
  content,
  editedContent: null,
  note: null,
  decidedBy: null,
  decidedAt: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  updatedAt: "2026-10-11T10:00:00.000Z",
  ...over,
});

describe("bản đang hiệu lực và quyền quyết", () => {
  it("bản người duyệt sửa thắng bản agent nộp", () => {
    const edited = { ...content, summary: "Đã sửa" };
    expect(effectiveContent(plan())).toBe(content);
    expect(effectiveContent(plan({ editedContent: edited }))).toBe(edited);
  });
  it("chỉ quyết được kế hoạch đang chờ, khi có quyền", () => {
    expect(canDecidePlan(plan(), true)).toBe(true);
    expect(canDecidePlan(plan(), false)).toBe(false);
    expect(canDecidePlan(plan({ status: "rejected" }), true)).toBe(false);
    expect(canDecidePlan(undefined, true)).toBe(false);
  });
});

describe("planStage", () => {
  const task = makeTask({ status: "awaiting_plan" });
  it("đang lập lần đầu và lập lại", () => {
    expect(planStage(makeTask({ status: "queued" }), undefined, makeRun({ state: "planning" }))).toMatch(
      /đang lập kế hoạch/,
    );
    expect(planStage(task, plan({ status: "rejected" }), makeRun({ state: "planning" }))).toMatch(/lập lại/);
  });
  it("chờ duyệt, đã duyệt, bị từ chối không lập lại", () => {
    expect(planStage(task, plan(), makeRun({ state: "awaiting_plan" }))).toMatch(/chờ người duyệt/);
    expect(planStage(task, plan({ status: "approved" }), makeRun({ state: "running" }))).toMatch(/đã duyệt/);
    expect(planStage(makeTask(), plan({ status: "rejected" }), makeRun({ state: "cancelled" }))).toMatch(/Giao lại/);
  });
  it("chưa có kế hoạch, không lập: không nói gì", () => expect(planStage(makeTask(), undefined, null)).toBeNull());
});

describe("form sửa kế hoạch", () => {
  it("nháp rồi đổi lại ra đúng nội dung cũ", () => {
    const back = fromDraft(toDraft(content));
    expect(back).toEqual({ ok: true, content });
    if (back.ok) expect(sameContent(back.content, content)).toBe(true);
  });

  it("bỏ dòng để trống hết, cắt khoảng trắng", () => {
    const d = toDraft(content);
    d.summary = "  Tóm tắt mới  ";
    d.steps.push({ key: "x", title: "", detail: " " });
    d.files.push({ key: "y", path: "", change: "", reason: "" });
    d.risks.push({ key: "z", text: "   " });
    d.questions = [];
    const r = fromDraft(d);
    expect(r.ok && r.content).toMatchObject({ summary: "Tóm tắt mới", questions: [] });
    expect(r.ok && r.content.steps).toHaveLength(2);
    expect(r.ok && r.content.files).toHaveLength(2);
    expect(r.ok && sameContent(r.content, content)).toBe(false);
  });

  it("báo lỗi tiếng Việt ở đúng ô", () => {
    const d: PlanDraft = {
      summary: " ",
      steps: [{ key: "s1", title: "", detail: "chỉ có chi tiết" }],
      files: [{ key: "f1", path: "", change: "add", reason: "" }],
      risks: [],
      questions: [],
    };
    expect(fromDraft(d)).toEqual({
      ok: false,
      errors: {
        summary: "Tóm tắt kế hoạch không được để trống.",
        "steps.s1.title": "Bước cần có tiêu đề.",
        "files.f1.path": "Nhập đường dẫn file hoặc xoá dòng này.",
      },
    });
    expect(fromDraft({ ...d, summary: "x", steps: [], files: [] })).toEqual({
      ok: false,
      errors: { steps: "Kế hoạch cần ít nhất một bước." },
    });
  });

  it("quá giới hạn của schema: báo phần sai", () => {
    const d = toDraft(content);
    d.risks = Array.from({ length: 101 }, (_, i) => ({ key: `r${i}`, text: `Rủi ro ${i}` }));
    expect(fromDraft(d)).toEqual({ ok: false, errors: { form: expect.stringContaining("rủi ro") } });
  });

  it("đổi thứ tự bước", () => {
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(move([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });
});
