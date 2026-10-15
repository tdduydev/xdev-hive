import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Breakdown,
  type BreakdownContext,
  findRequirements,
  parseBreakdown,
  writeBreakdown,
} from "./breakdown.ts";
import { type BreakdownGranularity, type BreakdownParser, sdlcBreakdown, sdlcMode } from "./sdlc.ts";
import { SDLC_PRESETS } from "./sdlc-presets/index.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/breakdown/${name}`, import.meta.url), "utf8");
const ctx: BreakdownContext = { homeProject: "payment-api", projects: ["web-shop", "mobile-app"] };
const KIRO_REQ = "(?<!\\.)\\d+\\.\\d+(?!\\.\\d)";

function result(md: string, parser: BreakdownParser, granularity: BreakdownGranularity, requirementId = "R-\\d+") {
  return parseBreakdown(md, { parser, granularity, requirementId, maxTasks: 30, maxChecklist: 20 }, ctx);
}

function parse(md: string, parser: BreakdownParser, granularity: BreakdownGranularity, requirementId?: string) {
  const r = result(md, parser, granularity, requirementId);
  if (!r.ok) throw new Error(`Đọc lỗi: ${JSON.stringify(r.errors)}`);
  return r.breakdown;
}

function errorsOf(md: string, parser: BreakdownParser, granularity: BreakdownGranularity = "item") {
  const r = result(md, parser, granularity);
  expect(r.ok).toBe(false);
  return r.errors.map((e) => e.message);
}

const shape = (b: Breakdown) => ({ ...b, tasks: b.tasks.map(({ line: _line, ...t }) => t) });

/** Đọc–ghi–đọc giữ nguyên cấu trúc (trừ số dòng). */
function roundTrip(b: Breakdown, requirementId?: string) {
  const again = parse(writeBreakdown(b, b.parser, ctx.homeProject), b.parser, b.granularity, requirementId);
  expect(shape(again)).toEqual(shape(b));
}

describe("kiro-tasks", () => {
  const md = fixture("kiro-tasks.md");

  it("task `N.` là task, `N.M` là checklist của task cha, `_Requirements_` là requirement", () => {
    const b = parse(md, "kiro-tasks", "item", KIRO_REQ);
    expect(sdlcBreakdown.parse(b)).toBeTruthy();
    expect(b.tasks.map((t) => t.sliceKey)).toEqual(["1", "2", "3"]);
    const [one, two, three] = b.tasks;
    expect(one?.requirementIds).toEqual(["1.1"]);
    expect(one?.files).toEqual(["src/models/", "src/services/"]);
    expect(two?.checklist.map((c) => [c.id, c.text])).toEqual([
      ["2.1", "Create core data model interfaces and types"],
      ["2.2", "Write unit tests for data models"],
    ]);
    expect(two?.requirementIds).toEqual(["2.1", "3.3", "1.2"]);
    // Phụ thuộc giữa việc con cùng task không thành phụ thuộc vào chính nó.
    expect(three).toMatchObject({ project: "web-shop", dependsOn: ["2"], requirementIds: ["4.1"] });
    expect(b.waves).toEqual([["1", "2"], ["3"]]);
    expect(b.requirements).toEqual(["1.1", "2.1", "3.3", "1.2", "4.1"]);
  });

  it("việc con không có task cha thành task riêng", () => {
    const b = parse("- [ ] 1. a\n- [ ] 2.1 b\n  - chi tiết\n", "kiro-tasks", "item");
    expect(b.tasks.map((t) => [t.sliceKey, t.body])).toEqual([
      ["1", ""],
      ["2.1", "- chi tiết"],
    ]);
  });

  it("đọc–ghi–đọc; task mới nhận số tiếp theo", () => {
    const b = parse(md, "kiro-tasks", "item", KIRO_REQ);
    roundTrip(b, KIRO_REQ);
    const added = { ...b, tasks: [...b.tasks, { ...(b.tasks[0] as Breakdown["tasks"][number]), sliceKey: "moi" }] };
    expect(writeBreakdown(added, "kiro-tasks", ctx.homeProject)).toContain("- [ ] 4. Set up project structure");
  });

  it("lỗi gọi theo mã Kiro", () => {
    expect(errorsOf("- [ ] 1. a\n  - _Depends on: 9_\n", "kiro-tasks")).toEqual([
      "Dòng 2: task 1 phụ thuộc task 9 không có.",
    ]);
    expect(errorsOf("- [ ] 1. a\n  - _Depends on: 2_\n- [ ] 2. b\n  - _Depends on: 1_\n", "kiro-tasks")).toEqual([
      "Dòng 1: phụ thuộc vòng task 1 → task 2 → task 1.",
    ]);
    expect(errorsOf("- [ ] 1. a\n- [ ] 1. b\n", "kiro-tasks")).toEqual(["Dòng 2: task 1 trùng với dòng 1."]);
    expect(errorsOf("# Plan\n", "kiro-tasks")).toEqual(["Không tìm thấy dòng task nào (dạng “- [ ] 1. Mô tả”)."]);
  });
});

describe("openspec-tasks", () => {
  const md = fixture("openspec-tasks.md");

  it("phần `## N.` là task, mục `N.M` là checklist, phụ thuộc theo số phần hoặc mã mục", () => {
    const b = parse(md, "openspec-tasks", "heading", "REQ-\\d{3}");
    expect(sdlcBreakdown.parse(b)).toBeTruthy();
    expect(b.tasks.map((t) => [t.sliceKey, t.title, t.project, t.dependsOn])).toEqual([
      ["1", "Chuẩn bị", "payment-api", []],
      ["2", "API hoàn tiền", "payment-api", ["1"]],
      ["3", "Giao diện", "web-shop", ["2"]],
    ]);
    expect(b.tasks[0]?.checklist.map((c) => c.id)).toEqual(["1.1", "1.2"]);
    expect(b.tasks[0]?.body).toBe("#### 1.2\n- Chạy `pnpm db:generate`");
    expect(b.tasks[2]?.parallel).toBe(true);
    expect(b.requirements).toEqual(["REQ-001", "REQ-002"]);
    roundTrip(b, "REQ-\\d{3}");
  });

  it("chỉ tách theo phần hoặc một task", () => {
    expect(errorsOf(md, "openspec-tasks", "item")).toEqual(["Bộ đọc “openspec-tasks” không tách theo độ mịn “item”."]);
    expect(errorsOf("## 1. A\n\n- [ ] 1.1 a\n  - Phụ thuộc: 3\n", "openspec-tasks", "heading")).toEqual([
      "Dòng 4: mục 1.1 phụ thuộc phần 3 không có.",
    ]);
  });
});

describe("bmad-stories", () => {
  const md = fixture("bmad-epics.md");

  it("mỗi Story là một task, checklist trong story thành checklist", () => {
    const b = parse(md, "bmad-stories", "item", "N?FR\\d+");
    expect(sdlcBreakdown.parse(b)).toBeTruthy();
    expect(b.tasks.map((t) => [t.sliceKey, t.title, t.project, t.dependsOn, t.parallel])).toEqual([
      ["1.1", "Tạo yêu cầu hoàn tiền", "payment-api", [], false],
      ["1.2", "Màn duyệt hoàn tiền", "web-shop", ["1.1"], true],
      ["2.1", "Báo cáo hoàn tiền theo tháng", "payment-api", ["1.1", "1.2"], false],
    ]);
    // Dòng ngay dưới tiêu đề story là mô tả, không nối vào tên story.
    expect(b.tasks[0]?.body.startsWith("As a khách hàng,\nI want")).toBe(true);
    expect(b.tasks[0]?.checklist.map((c) => c.id)).toEqual(["1.1.1", "1.1.2"]);
    expect(b.requirements).toEqual(["FR1", "FR3", "NFR2"]);
    roundTrip(b, "N?FR\\d+");
  });

  it("lỗi gọi theo Story", () => {
    expect(errorsOf("### Story 1.1: a\n\n**Phụ thuộc**: Story 1.5\n", "bmad-stories")).toEqual([
      "Dòng 3: Story 1.1 phụ thuộc Story 1.5 không có.",
    ]);
    expect(errorsOf("### Story 1.1: a\n\nDự án: kho\n", "bmad-stories")).toEqual([
      "Dòng 1: dự án kho không tham gia hạng mục.",
    ]);
  });
});

describe("aidlc-units", () => {
  const md = fixture("aidlc-units.md");

  it("mỗi Unit là một task, phụ thuộc `Unit N` hoặc `unit-N`", () => {
    const b = parse(md, "aidlc-units", "item");
    expect(b.tasks.map((t) => [t.sliceKey, t.project, t.dependsOn, t.requirementIds])).toEqual([
      ["unit-1", "payment-api", [], ["R-1"]],
      ["unit-2", "web-shop", ["unit-1"], ["R-2"]],
      ["unit-3", "payment-api", ["unit-1", "unit-2"], []],
    ]);
    expect(b.waves).toEqual([["unit-1"], ["unit-2"], ["unit-3"]]);
    roundTrip(b);
  });

  it("độ mịn single đọc nguyên văn: một task, checklist thường (preset aidlc-express)", () => {
    const b = parse(md, "aidlc-units", "single");
    expect(b.tasks).toHaveLength(1);
    expect(b.tasks[0]?.title).toBe("Units of Work");
    expect(b.tasks[0]?.checklist.map((c) => c.text)).toEqual([
      "Bảng `payments`",
      "API `POST /payments`",
      "Màn hoàn tiền (R-2)",
    ]);
  });

  it("khuôn của preset aidlc-express đọc được", () => {
    const mode = SDLC_PRESETS["aidlc-express"];
    const d = mode?.decomposition;
    const artifact = mode?.phases.flatMap((p) => p.artifacts).find((a) => a.id === d?.artifact);
    expect(d && artifact?.template).toBeTruthy();
    if (!d || !artifact?.template) return;
    expect(parseBreakdown(artifact.template, d, ctx).errors).toEqual([]);
  });
});

describe("độ mịn theo bộ đọc", () => {
  it("chế độ chọn độ mịn bộ đọc không hiểu thì không hợp lệ", () => {
    const base = SDLC_PRESETS.speckit;
    if (!base?.decomposition) throw new Error("thiếu preset speckit");
    const bad = { ...base, decomposition: { ...base.decomposition, parser: "kiro-tasks", granularity: "heading" } };
    const r = sdlcMode.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain("Bộ đọc “kiro-tasks” không tách theo độ mịn “heading”.");
  });

  it("requirement trong chữ nghiêng `_…_` vẫn được nhận, trong tên thì không", () => {
    expect(findRequirements("_Requirements: 1.1, 2.3_ và v_1.2", KIRO_REQ)).toEqual(["1.1", "2.3"]);
  });
});
