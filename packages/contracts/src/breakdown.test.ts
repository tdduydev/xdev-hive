import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Breakdown,
  type BreakdownContext,
  breakdownWaves,
  coverage,
  findRequirements,
  parseBreakdown,
  writeBreakdown,
} from "./breakdown.ts";
import { type BreakdownGranularity, type BreakdownParser, sdlcBreakdown } from "./sdlc.ts";
import { SDLC_PRESETS } from "./sdlc-presets/index.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/breakdown/${name}`, import.meta.url), "utf8");
const ctx: BreakdownContext = { homeProject: "payment-api", projects: ["web-shop", "mobile-app"] };
const dec = (parser: BreakdownParser, granularity: BreakdownGranularity, requirementId = "FR-\\d{3}") => ({
  parser,
  granularity,
  requirementId,
  maxTasks: 30,
  maxChecklist: 20,
});

function parse(md: string, parser: BreakdownParser, granularity: BreakdownGranularity, requirementId?: string) {
  const r = parseBreakdown(md, dec(parser, granularity, requirementId), ctx);
  if (!r.ok) throw new Error(`Đọc lỗi: ${JSON.stringify(r.errors)}`);
  return r.breakdown;
}

function errorsOf(md: string, granularity: BreakdownGranularity = "item", parser: BreakdownParser = "hive-tasks") {
  const r = parseBreakdown(md, dec(parser, granularity, "R-\\d+"), ctx);
  expect(r.ok).toBe(false);
  return r.errors.map((e) => e.message);
}

/** Số dòng đổi sau khi ghi lại; cấu trúc thì không. */
const shape = (b: Breakdown) => ({ ...b, tasks: b.tasks.map(({ line: _line, ...t }) => t) });

describe("parseBreakdown — hive-tasks (tasks.md của specs/009)", () => {
  const md = fixture("hive-009-tasks.md");

  it("độ mịn item: mỗi dòng T### là một task, phụ thuộc và đợt đúng", () => {
    const b = parse(md, "hive-tasks", "item");
    expect(b.tasks).toHaveLength(26);
    expect(sdlcBreakdown.parse(b)).toBeTruthy();
    const t = (key: string) => b.tasks.find((x) => x.sliceKey === key);
    expect(t("T010")?.dependsOn).toEqual(["T001", "T002"]);
    // "T071 (cùng làn)" kiểu chú thích vẫn chỉ lấy mã; "không" là không phụ thuộc.
    expect(t("T001")?.dependsOn).toEqual([]);
    expect(t("T003")?.parallel).toBe(true);
    expect(t("T010")?.title).toBe("[US1] `knowledge` nhận quy trình Code");
    expect(t("T004")?.title).toContain("shadcn/ui; ghi lại thành mô tả component");
    expect(t("T003")?.files).toEqual([
      "apps/hub/src/modules/scm/types.ts",
      "apps/hub/src/modules/scm/github.ts",
      "apps/hub/src/modules/scm/gitlab.ts",
      "apps/hub/src/modules/scm/memory.ts",
      "apps/hub/src/modules/scm/local.ts",
      "apps/hub/src/modules/scm/index.ts",
      "apps/hub/src/modules/scm/github.test.ts",
      "apps/hub/src/modules/scm/gitlab.test.ts",
      "apps/hub/src/modules/scm/local.test.ts",
      "apps/hub/src/modules/scm/fixtures/**",
    ]);
    // Dòng phụ thuộc là cấu trúc, không nằm lại trong body; phần "Mức" thì giữ.
    expect(t("T003")?.body).not.toContain("Phụ thuộc");
    expect(t("T003")?.body).toContain("- **Mức**: vừa");
    expect(b.waves[0]).toEqual(["T001", "T003", "T004"]);
    expect(b.waves.flat()).toHaveLength(26);
    expect(b.tasks.every((x) => x.project === "payment-api")).toBe(true);
  });

  it("độ mịn heading: mỗi phase là một task, dòng T### thành checklist, phụ thuộc theo phần", () => {
    const b = parse(md, "hive-tasks", "heading");
    expect(b.tasks).toHaveLength(11);
    const [nen, us1] = b.tasks;
    expect(nen?.sliceKey).toBe("phase-1-nen-chan-moi-story");
    expect(nen?.title).toBe("Phase 1: Nền (chặn mọi story)");
    expect(nen?.checklist.map((c) => c.id)).toEqual(["T001", "T002", "T003", "T004"]);
    expect(nen?.checklist[2]?.text).toBe("[P] `GitProvider.prFiles` và `setCommitStatus`");
    expect(us1?.dependsOn).toEqual(["phase-1-nen-chan-moi-story"]);
    // Chi tiết của mục nằm trong body dưới mã của mục, để bộ ghi đặt lại đúng chỗ.
    expect(nen?.body).toContain("#### T003\n- GitHub `GET /pulls/{n}/files`");
    expect(nen?.body.startsWith("**Checkpoint**: contract, bảng, provider sẵn sàng")).toBe(true);
    expect(b.waves[0]).toEqual(["phase-1-nen-chan-moi-story"]);
  });
});

describe("parseBreakdown — speckit-tasks", () => {
  const md = fixture("speckit-hoan-tien.md");

  it("US5 Independent Test: 3 phần, 14 dòng T###, heading → 3 task, đợt {1} rồi {2, 3}", () => {
    const b = parse(md, "speckit-tasks", "heading");
    expect(b.tasks.map((t) => t.checklist.length)).toEqual([4, 5, 5]);
    const [p1, p2, p3] = b.tasks.map((t) => t.sliceKey);
    expect(b.tasks[1]?.dependsOn).toEqual([p1]);
    expect(b.tasks[2]?.dependsOn).toEqual([p1]);
    expect(b.waves).toEqual([[p1], [p2, p3]]);
    expect(b.tasks[1]?.checklist[3]).toEqual({ id: "T008", text: "[US1] Gắn route vào router", requirementIds: [] });

    const cov = coverage(["FR-001", "FR-002", "FR-003", "FR-004", "FR-005", "FR-006"], b);
    expect(cov.total).toEqual({ requirements: 6, planned: 5 });
    expect(cov.missing).toEqual(["FR-006"]);
  });

  it("độ mịn item: phụ thuộc trong ngoặc và dòng con đều được đọc", () => {
    const b = parse(md, "speckit-tasks", "item");
    expect(b.tasks).toHaveLength(14);
    const deps = Object.fromEntries(b.tasks.filter((t) => t.dependsOn.length).map((t) => [t.sliceKey, t.dependsOn]));
    expect(deps).toEqual({ T006: ["T001"], T008: ["T002"], T011: ["T003"], T013: ["T010"] });
    expect(b.tasks.find((t) => t.sliceKey === "T006")?.title).toBe(
      "[US1] Test số tiền hoàn không vượt số đã trả (FR-003)",
    );
    expect(b.tasks.find((t) => t.sliceKey === "T014")?.files).toEqual(["apps/web/e2e/refunds.spec.ts"]);
  });

  it("SC-005: mẫu Spec Kit 58 dòng T### → ≤ 12 task hub, mỗi task ≤ 20 mục checklist", () => {
    const sample = fixture("speckit-58.md");
    const b = parse(sample, "speckit-tasks", "heading");
    expect(b.tasks.length).toBeLessThanOrEqual(12);
    expect(b.tasks.every((t) => t.checklist.length >= 1 && t.checklist.length <= 20)).toBe(true);
    // Dòng T999 trong khối code không phải task.
    expect(b.tasks.flatMap((t) => t.checklist)).toHaveLength(58);

    expect(errorsOf(sample, "item", "speckit-tasks")).toEqual([
      "Bản tách có 58 task, vượt giới hạn 30 của chế độ. Gộp theo phần (độ mịn heading).",
    ]);
  });
});

describe("parseBreakdown — comment HTML", () => {
  it("chữ trong comment không là task hay phụ thuộc", () => {
    const md = [
      "# Tasks",
      "",
      "<!--",
      '  Phụ thuộc ghi ở mục Dependencies: "T003 phụ thuộc T001, T002".',
      "  - [ ] T009 Ví dụ",
      "-->",
      "",
      "## Phase 1: Nền",
      "",
      "- [ ] T001 Bảng <!-- ghi chú --> báo cáo",
      "- [ ] T002 Hàm tổng hợp",
      "",
      "## Phase 2: Story",
      "",
      "- [ ] T003 Nút xuất (phụ thuộc T001)",
    ].join("\n");
    const b = parse(md, "speckit-tasks", "heading");
    expect(b.tasks.map((t) => [t.sliceKey, t.dependsOn])).toEqual([
      ["phase-1-nen", []],
      ["phase-2-story", ["phase-1-nen"]],
    ]);
    expect(b.tasks.flatMap((t) => t.checklist.map((c) => c.id))).toEqual(["T001", "T002", "T003"]);
  });

  it("khuôn tasks.md của preset speckit đọc được với độ mịn của preset", () => {
    const mode = SDLC_PRESETS.speckit;
    const d = mode?.decomposition;
    const template = mode?.phases.flatMap((p) => p.artifacts).find((a) => a.id === d?.artifact)?.template;
    if (!d || !template) throw new Error("speckit đổi cấu trúc");
    const r = parseBreakdown(template, d, { homeProject: "payment-api", projects: [] });
    expect(r.errors).toEqual([]);
  });
});

describe("parseBreakdown — dự án (D24)", () => {
  const md = fixture("hive-nhieu-du-an.md");

  it("thẻ [@key] trên dòng task, dòng “Dự án:” dưới tiêu đề phần, mặc định dự án chính", () => {
    const b = parse(md, "hive-tasks", "item", "R-\\d+");
    expect(Object.fromEntries(b.tasks.map((t) => [t.sliceKey, t.project]))).toEqual({
      T001: "payment-api",
      T002: "payment-api",
      T003: "web-shop",
      T004: "web-shop",
      T005: "mobile-app",
    });
    expect(b.tasks.find((t) => t.sliceKey === "T005")?.title).toBe("Màn hoàn tiền trên app (R-3)");
    expect(b.waves).toEqual([["T001"], ["T002", "T003", "T005"], ["T004"]]);

    const cov = coverage(["R-1", "R-2", "R-3", "R-4"], b);
    expect(cov.total).toEqual({ requirements: 4, planned: 3 });
    expect(cov.byProject).toEqual([
      { project: "payment-api", requirements: 4, planned: 2 },
      { project: "web-shop", requirements: 4, planned: 1 },
      { project: "mobile-app", requirements: 4, planned: 1 },
    ]);
    expect(cov.missing).toEqual(["R-4"]);
  });

  it("độ mịn heading: dự án theo phần, phụ thuộc liên dự án giữ nguyên", () => {
    const b = parse(md, "hive-tasks", "heading", "R-\\d+");
    expect(b.tasks.map((t) => [t.sliceKey, t.project, t.dependsOn])).toEqual([
      ["phase-1-api-hoan-tien", "payment-api", []],
      ["phase-2-web", "web-shop", ["phase-1-api-hoan-tien"]],
      ["phase-3-mobile", "mobile-app", ["phase-1-api-hoan-tien"]],
    ]);
  });

  it("dự án không tham gia hạng mục là lỗi có số dòng", () => {
    const md2 = "# Tasks\n\n## Web\n\nDự án: mobile\n\n- [ ] T001 Màn\n- [ ] T002 [@shop] Nút\n";
    expect(errorsOf(md2)).toEqual([
      "Dòng 5: dự án mobile không tham gia hạng mục.",
      "Dòng 8: dự án shop không tham gia hạng mục.",
    ]);
  });

  it("độ mịn heading: một phần chỉ thuộc một dự án", () => {
    const md2 = "## Web\n\nDự án: web-shop\n\n- [ ] T001 Màn\n- [ ] T002 [@mobile-app] Nút\n";
    expect(errorsOf(md2, "heading")).toEqual([
      "Dòng 6: T002 thuộc dự án mobile-app, khác dự án web-shop của phần “Web”. Tách thành phần riêng.",
    ]);
    expect(errorsOf("- [ ] T001 [@web-shop] [@mobile-app] Màn\n")).toEqual([
      "Dòng 1: T001 có nhiều thẻ dự án (web-shop, mobile-app).",
    ]);
  });

  it("thẻ dự án trong `code` là ví dụ, không phải thẻ", () => {
    const b = parse("- [ ] T001 Ghi thẻ `[@dự-án]` và `[@web-shop]` vào khuôn\n", "hive-tasks", "item");
    expect(b.tasks[0]?.project).toBe("payment-api");
    expect(b.tasks[0]?.title).toBe("Ghi thẻ `[@dự-án]` và `[@web-shop]` vào khuôn");
  });
});

describe("parseBreakdown — lỗi", () => {
  it("phụ thuộc trỏ tới task không có", () => {
    const md = ["## A", "", "- [ ] T001 Một", "- [ ] T009 Chín", "  - **Phụ thuộc**: T001, T099 · **Mức**: nhẹ"].join(
      "\n",
    );
    expect(errorsOf(md)).toEqual(["Dòng 5: T009 phụ thuộc T099 không có."]);
    expect(errorsOf("## A\n\n**Phụ thuộc**: T077\n\n- [ ] T001 Một\n", "heading")).toEqual([
      "Dòng 3: phần “A” phụ thuộc T077 không có.",
    ]);
  });

  it("vòng phụ thuộc, tự phụ thuộc, mã trùng", () => {
    const cycle = "- [ ] T001 A (phụ thuộc T003)\n- [ ] T002 B (phụ thuộc T001)\n- [ ] T003 C (phụ thuộc T002)\n";
    expect(errorsOf(cycle)).toEqual(["Dòng 1: phụ thuộc vòng T001 → T003 → T002 → T001."]);
    expect(errorsOf("- [ ] T001 A (depends on T001)\n")).toEqual(["Dòng 1: T001 phụ thuộc chính nó."]);
    expect(errorsOf("- [ ] T001 A\n- [ ] T001 B\n")).toEqual(["Dòng 2: T001 trùng với dòng 1."]);

    const sections = "## A\n\n- [ ] T001 a (phụ thuộc T002)\n\n## B\n\n- [ ] T002 b (phụ thuộc T001)\n";
    expect(errorsOf(sections, "heading")).toEqual(["Dòng 1: phụ thuộc vòng “A” → “B” → “A”."]);
  });

  it("vượt giới hạn checklist, không có task, regex sai, bộ đọc chưa có", () => {
    const many = ["## Lớn", "", ...Array.from({ length: 21 }, (_, k) => `- [ ] T${String(k + 1).padStart(3, "0")} x`)];
    expect(errorsOf(many.join("\n"), "heading")).toEqual([
      "Dòng 1: “Lớn” có 21 mục checklist, vượt giới hạn 20. Tách thành nhiều phần nhỏ hơn (mỗi phần một task).",
    ]);
    expect(errorsOf("# Tasks\n\nChưa có gì.\n")).toEqual(["Không tìm thấy dòng task nào (dạng “- [ ] T001 Mô tả”)."]);
    const bad = parseBreakdown("- [ ] T001 a\n", { ...dec("hive-tasks", "item"), requirementId: "FR-(" }, ctx);
    expect(bad.errors).toEqual([{ line: 0, message: "Mẫu mã requirement không phải regex hợp lệ." }]);
    const kiro = parseBreakdown("- [ ] 1. a\n", dec("kiro-tasks", "item"), ctx);
    expect(kiro.errors).toEqual([{ line: 0, message: "Bộ đọc “kiro-tasks” chưa có." }]);
  });

  it("phụ thuộc ghi dạng khoảng và task của spec khác", () => {
    const md = "- [ ] T001 a\n- [ ] T002 b\n- [ ] T003 c\n- [ ] T004 d\n  - **Phụ thuộc**: T001–T003, spec 009 T022\n";
    expect(parse(md, "hive-tasks", "item").tasks[3]?.dependsOn).toEqual(["T001", "T002", "T003"]);
  });
});

describe("parseBreakdown — single", () => {
  it("cả tài liệu là một task, checklist là các dòng T###", () => {
    const b = parse(fixture("speckit-hoan-tien.md"), "speckit-tasks", "single");
    expect(b.tasks).toHaveLength(1);
    expect(b.tasks[0]?.sliceKey).toBe("single");
    expect(b.tasks[0]?.title).toBe("Tasks: Hoàn tiền một phần");
    expect(b.tasks[0]?.checklist).toHaveLength(14);
    expect(b.tasks[0]?.dependsOn).toEqual([]);
    expect(b.waves).toEqual([["single"]]);
  });

  it("không có mã T### thì checklist là các dòng checkbox", () => {
    const md =
      "# Sửa lỗi đăng nhập\n\n## Cách sửa\n\n- [ ] Đổi hạn token\n  - file `src/auth/token.ts`\n- [ ] Thêm test\n";
    const b = parse(md, "hive-tasks", "single");
    expect(b.tasks[0]?.checklist.map((c) => [c.id, c.text])).toEqual([
      ["1", "Đổi hạn token"],
      ["2", "Thêm test"],
    ]);
    expect(b.tasks[0]?.files).toEqual(["src/auth/token.ts"]);
  });
});

describe("writeBreakdown — đọc–ghi–đọc giữ nguyên cấu trúc", () => {
  const cases: [string, BreakdownParser, string][] = [
    ["hive-009-tasks.md", "hive-tasks", "FR-\\d{3}"],
    ["hive-nhieu-du-an.md", "hive-tasks", "R-\\d+"],
    ["speckit-hoan-tien.md", "speckit-tasks", "FR-\\d{3}"],
    ["speckit-58.md", "speckit-tasks", "FR-\\d{3}"],
  ];
  const granularities: BreakdownGranularity[] = ["item", "heading", "single"];

  for (const [file, parser, rid] of cases) {
    for (const g of granularities) {
      // 58 task vượt giới hạn item; tài liệu nhiều dự án hay dài quá 20 mục không đọc được ở độ mịn single.
      if (file === "speckit-58.md" && g === "item") continue;
      if (g === "single" && file !== "speckit-hoan-tien.md") continue;
      it(`${file} · ${g}`, () => {
        const first = parse(fixture(file), parser, g, rid);
        for (const home of ["payment-api", undefined]) {
          const md = writeBreakdown(first, parser, home);
          const again = parse(md, parser, g, rid);
          expect(shape(again)).toEqual(shape(first));
          // Ghi lần hai ra đúng chữ lần một: bộ ghi là điểm bất động.
          expect(writeBreakdown(again, parser, home)).toBe(md);
        }
      });
    }
  }

  it("hive item: phụ thuộc ghi chung dòng với Mức, task không có phụ thuộc ghi “không”", () => {
    const b = parse(fixture("hive-nhieu-du-an.md"), "hive-tasks", "item", "R-\\d+");
    const md = writeBreakdown(b, "hive-tasks", "payment-api");
    expect(md).toContain("- [ ] T002 [P] Webhook báo trạng thái hoàn tiền (R-2)\n");
    expect(md).toContain("  - **Phụ thuộc**: T001 · **Mức**: vừa\n");
    expect(md).toContain("  - **Phụ thuộc**: không · **Mức**: nặng\n");
    expect(md).toContain("- [ ] T005 [P] [@mobile-app] Màn hoàn tiền trên app (R-3)\n");
    // Thứ tự task giữ như tài liệu, không xếp lại theo đợt.
    expect(md.indexOf("T003")).toBeLessThan(md.indexOf("T004"));
  });

  it("speckit item: phụ thuộc ghi trong ngoặc trên dòng task", () => {
    const b = parse(fixture("speckit-hoan-tien.md"), "speckit-tasks", "item");
    expect(writeBreakdown(b, "speckit-tasks", "payment-api")).toContain(
      "- [ ] T006 [P] [US1] Test số tiền hoàn không vượt số đã trả (FR-003) (phụ thuộc T001)\n",
    );
  });

  it("sửa trên màn duyệt (gộp phần, thêm phụ thuộc, đổi tên, task mới) rồi ghi lại", () => {
    const b = parse(fixture("speckit-hoan-tien.md"), "speckit-tasks", "heading");
    const [p1, p2, p3] = b.tasks;
    if (!p1 || !p2 || !p3) throw new Error("thiếu phần");
    const edited: Breakdown = {
      ...b,
      tasks: [
        { ...p1, title: "Nền dữ liệu" },
        // Gộp phần 3 vào phần 2 và thêm một mục mới chưa có mã.
        {
          ...p2,
          checklist: [...p2.checklist, ...p3.checklist, { id: "moi", text: "Ghi log hoàn tiền", requirementIds: [] }],
        },
        {
          ...p3,
          sliceKey: "kiem-thu",
          title: "Kiểm thử",
          body: "",
          checklist: [],
          dependsOn: [p2.sliceKey],
          project: "web-shop",
        },
      ],
    };
    const md = writeBreakdown(edited, "speckit-tasks", "payment-api");
    expect(md).toContain(`## Nền dữ liệu {#${p1.sliceKey}}`);
    expect(md).toContain("- [ ] T015 Ghi log hoàn tiền");
    expect(md).toContain("## Kiểm thử\n\nDự án: web-shop\n**Phụ thuộc**: T005\n");
    const again = parse(md, "speckit-tasks", "heading");
    expect(again.tasks.map((t) => [t.sliceKey, t.title, t.project, t.dependsOn, t.checklist.length])).toEqual([
      [p1.sliceKey, "Nền dữ liệu", "payment-api", [], 4],
      [p2.sliceKey, p2.title, "payment-api", [p1.sliceKey], 11],
      // Phần rỗng có một mục mang tên phần để không biến mất khi đọc lại.
      ["kiem-thu", "Kiểm thử", "web-shop", [p2.sliceKey], 1],
    ]);
    expect(again.waves).toEqual([[p1.sliceKey], [p2.sliceKey], ["kiem-thu"]]);
    // Chi tiết của T011 (dòng “Phụ thuộc: T003” đã thành phụ thuộc của phần) không còn; mục khác giữ chi tiết.
    expect(md).not.toContain("Phụ thuộc: T003");
  });

  it("item: task mới chưa có mã T### nhận mã kế tiếp, phụ thuộc đổi theo", () => {
    const b = parse("- [ ] T001 a\n- [ ] T002 b\n", "hive-tasks", "item");
    const [t1, t2] = b.tasks;
    if (!t1 || !t2) throw new Error("thiếu task");
    const extra = { ...t2, sliceKey: "new-1", title: "c", dependsOn: ["T002"] };
    const md = writeBreakdown(
      { ...b, tasks: [{ ...t1, dependsOn: ["new-1"] }, t2, extra] },
      "hive-tasks",
      "payment-api",
    );
    const again = parse(md, "hive-tasks", "item");
    expect(again.tasks.map((t) => [t.sliceKey, t.title, t.dependsOn])).toEqual([
      ["T001", "a", ["T003"]],
      ["T002", "b", []],
      ["T003", "c", ["T002"]],
    ]);
    expect(again.waves).toEqual([["T002"], ["T003"], ["T001"]]);
  });

  it("mô tả quá dài được cắt ở tiêu đề, bản đầy đủ giữ trong body", () => {
    const long = `Làm ${"rất ".repeat(60)}nhiều việc`;
    const b = parse(`- [ ] T001 ${long}\n  - **Mức**: nhẹ\n`, "hive-tasks", "item");
    expect(b.tasks[0]?.title).toHaveLength(200);
    expect(b.tasks[0]?.body).toBe(`- Mô tả: ${long}\n- **Mức**: nhẹ`);
    const again = parse(writeBreakdown(b, "hive-tasks", "payment-api"), "hive-tasks", "item");
    expect(shape(again)).toEqual(shape(b));
  });

  it("checklist con của task ở độ mịn item", () => {
    const md = "- [ ] T001 Màn đăng nhập (FR-001)\n  - Ghi chú\n  - [ ] Form (FR-002)\n  - [x] Nút quên mật khẩu\n";
    const b = parse(md, "speckit-tasks", "item");
    expect(b.tasks[0]?.checklist).toEqual([
      { id: "T001.1", text: "Form (FR-002)", requirementIds: ["FR-002"] },
      { id: "T001.2", text: "Nút quên mật khẩu", requirementIds: [] },
    ]);
    expect(b.tasks[0]?.requirementIds).toEqual(["FR-001", "FR-002"]);
    expect(shape(parse(writeBreakdown(b, "speckit-tasks", "payment-api"), "speckit-tasks", "item"))).toEqual(shape(b));
  });
});

describe("breakdownWaves, findRequirements", () => {
  it("đợt sắp topo giữ thứ tự tài liệu; có vòng thì trả vòng", () => {
    expect(
      breakdownWaves([
        { sliceKey: "c", dependsOn: ["a", "b"] },
        { sliceKey: "a", dependsOn: [] },
        { sliceKey: "b", dependsOn: ["a", "x"] },
      ]),
    ).toEqual({ waves: [["a"], ["b"], ["c"]], cycle: null });
    expect(
      breakdownWaves([
        { sliceKey: "a", dependsOn: [] },
        { sliceKey: "b", dependsOn: ["c"] },
        { sliceKey: "c", dependsOn: ["b"] },
      ]),
    ).toEqual({ waves: [["a"]], cycle: ["b", "c"] });
  });

  it("mã requirement phải đứng riêng", () => {
    expect(findRequirements("R-1, FR-002, (R-12) và R-1 lần nữa; xR-3", "R-\\d+")).toEqual(["R-1", "R-12"]);
    expect(findRequirements("FR-001 FR-0012", "FR-\\d{3}")).toEqual(["FR-001"]);
    expect(findRequirements("x", "(")).toBeNull();
  });
});
