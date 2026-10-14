import { describe, expect, it } from "vitest";
import {
  checkRepoPath,
  isHeavySdlc,
  renderRepoPath,
  type SdlcMode,
  sdlcMode,
  sdlcModeWarnings,
  sdlcSlug,
} from "../sdlc.ts";
import { isSdlcPresetId, SDLC_PRESET_IDS, SDLC_PRESETS } from "./index.ts";

const MVP = ["bugfix", "small", "aidlc-express", "speckit"] as const;
const preset = (id: (typeof MVP)[number]): SdlcMode => {
  const mode = SDLC_PRESETS[id];
  if (!mode) throw new Error(`Thiếu preset ${id}`);
  return mode;
};

const artifactsOf = (mode: SdlcMode) => mode.phases.flatMap((p) => p.artifacts);
const phaseOf = (mode: SdlcMode, id: string) => {
  const phase = mode.phases.find((p) => p.id === id);
  if (!phase) throw new Error(`Thiếu giai đoạn ${id}`);
  return phase;
};
const headings = (md: string) =>
  md
    .split("\n")
    .filter((l) => /^\s*#{1,6}\s/.test(l))
    .map((l) => l.replace(/^\s*#+\s*/, "").toLowerCase());

const VARS = { number: 12, slug: sdlcSlug("Hoàn tiền một phần"), date: "2026-10-14" };

describe("preset MVP", () => {
  it("có đủ bốn preset, id khớp khoá và nằm trong danh sách preset", () => {
    expect(Object.keys(SDLC_PRESETS).sort()).toEqual([...MVP].sort());
    for (const id of MVP) {
      expect(preset(id).id).toBe(id);
      expect(isSdlcPresetId(id)).toBe(true);
      expect(SDLC_PRESET_IDS).toContain(id);
    }
  });

  it("mọi preset parse lại qua sdlcMode và không còn cảnh báo", () => {
    for (const id of MVP) {
      const again = sdlcMode.safeParse(preset(id));
      expect(again.success, id).toBe(true);
      expect(sdlcModeWarnings(preset(id)), id).toEqual([]);
    }
  });

  it("prompt chỉ dùng biến mà hub điền", () => {
    const allowed = new Set(["idea", "artifacts", "answers", "feedback", "constitution", "projects"]);
    for (const id of MVP)
      for (const phase of preset(id).phases)
        for (const step of phase.steps)
          for (const [, name] of step.prompt.matchAll(/\{(\w+)\}/g))
            expect(allowed.has(name ?? ""), `${id}/${step.id}: {${name}}`).toBe(true);
  });

  it("khuôn có đủ mục bắt buộc, không mang sẵn dấu câu hỏi mở", () => {
    for (const id of MVP)
      for (const a of artifactsOf(preset(id))) {
        const hs = headings(a.template ?? "");
        for (const s of a.sections)
          expect(
            hs.some((h) => h.includes(s.toLowerCase())),
            `${id}/${a.id}: thiếu mục “${s}”`,
          ).toBe(true);
        expect(a.template ?? "", `${id}/${a.id}`).not.toContain("[NEEDS CLARIFICATION");
      }
  });

  it("luật `sections` của cổng dùng cùng danh sách mục với tài liệu của giai đoạn", () => {
    for (const id of MVP)
      for (const phase of preset(id).phases) {
        const gates = phase.gate.flatMap((g) => g.gates).filter((g) => g.rules?.includes("sections"));
        const required = phase.artifacts.find((a) => a.required && a.sections.length);
        for (const g of gates) expect(g.sections, `${id}/${phase.id}`).toEqual(required?.sections);
      }
  });
});

describe("đường dẫn tài liệu", () => {
  it("điền {NNN}, {slug}, {date} cho dự án chính", () => {
    const paths = (id: (typeof MVP)[number]) =>
      Object.fromEntries(artifactsOf(preset(id)).map((a) => [a.id, renderRepoPath(a.path, VARS)]));
    expect(paths("speckit")).toMatchObject({
      spec: "specs/012-hoan-tien-mot-phan/spec.md",
      plan: "specs/012-hoan-tien-mot-phan/plan.md",
      research: "specs/012-hoan-tien-mot-phan/research.md",
      "data-model": "specs/012-hoan-tien-mot-phan/data-model.md",
      tasks: "specs/012-hoan-tien-mot-phan/tasks.md",
    });
    expect(paths("bugfix")).toEqual({ bugfix: "fixes/012-hoan-tien-mot-phan/bugfix.md" });
    expect(paths("aidlc-express")).toEqual({
      requirements:
        "aidlc/spaces/default/intents/2026-10-14-hoan-tien-mot-phan/inception/requirements-analysis/requirements.md",
      "test-results":
        "aidlc/spaces/default/intents/2026-10-14-hoan-tien-mot-phan/construction/build-and-test/test-results.md",
    });
    expect(paths("small")).toEqual({});
  });

  it("repo tham gia dùng <home>-<NNN> thay cho {NNN}", () => {
    const spec = artifactsOf(preset("speckit")).find((a) => a.id === "spec");
    expect(renderRepoPath(spec?.path ?? "", { ...VARS, homeKey: "payment-api" })).toBe(
      "specs/payment-api-012-hoan-tien-mot-phan/spec.md",
    );
    const bugfix = artifactsOf(preset("bugfix"))[0];
    expect(renderRepoPath(bugfix?.path ?? "", { ...VARS, homeKey: "payment-api" })).toBe(
      "fixes/payment-api-012-hoan-tien-mot-phan/bugfix.md",
    );
  });

  it("contract của speckit điền {name} và {ext} theo định dạng", () => {
    const contract = artifactsOf(preset("speckit")).find((a) => a.scope === "contract");
    expect(contract).toMatchObject({ repeatable: true, required: false });
    expect(renderRepoPath(contract?.path ?? "", { ...VARS, name: "refund-api", format: "openapi" })).toBe(
      "specs/012-hoan-tien-mot-phan/contracts/refund-api.yaml",
    );
  });

  it("mọi đường dẫn hợp lệ và không còn biến sau khi điền", () => {
    for (const id of MVP)
      for (const a of artifactsOf(preset(id))) {
        expect(checkRepoPath(a.path, { contract: a.scope === "contract" }), `${id}/${a.id}`).toBeNull();
        const out = renderRepoPath(a.path, { ...VARS, name: "x", format: "openapi", homeKey: "home" });
        expect(out, `${id}/${a.id}`).not.toMatch(/[{}]/);
      }
  });
});

describe("mặc định theo bảng của plan.md", () => {
  it("bugfix: nhẹ, chặn mềm, tự duyệt cổng tech lead ngưỡng 8,5 sau checkpoint AI", () => {
    const m = preset("bugfix");
    expect(m).toMatchObject({ method: "hive", blocking: "soft", sizes: ["S"] });
    expect(m.phases.map((p) => p.kind)).toEqual(["requirements", "implementation"]);
    const fix = phaseOf(m, "fix");
    const gates = fix.gate.flatMap((g) => g.gates);
    expect(gates.map((g) => g.kind)).toEqual(["rule", "ai", "human"]);
    expect(gates[0]?.rules).toEqual(["sections", "no-open-questions"]);
    expect(gates[2]).toMatchObject({ id: "lead", slaHours: 8, reviewers: { roles: ["team-admin"], quorum: 1 } });
    expect(fix.autoApprove).toEqual({ gates: ["lead"], minScore: 8.5, revokeHours: 24 });
    expect(fix.perProjectGates).toEqual(["lead"]);
    expect(m.decomposition).toMatchObject({ granularity: "single", maxTasks: 1 });
    expect(artifactsOf(m).some((a) => a.scope === "contract")).toBe(false);
    // Cỡ L/XL thì giai đoạn yêu cầu luôn cần người dù preset khai tự duyệt.
    expect(isHeavySdlc(m.sizes, "S")).toBe(false);
    expect(isHeavySdlc(m.sizes, "L")).toBe(true);
  });

  it("small: một giai đoạn triển khai, không tài liệu, không cổng, không tách task", () => {
    const m = preset("small");
    expect(m).toMatchObject({ blocking: "none", decomposition: null, sizes: ["S"] });
    expect(m.phases).toHaveLength(1);
    expect(m.phases[0]).toMatchObject({ kind: "implementation", artifacts: [], steps: [], gate: [] });
    expect(m.phases[0]?.autoApprove).toBeUndefined();
  });

  it("aidlc-express: yêu cầu có PO duyệt, không tự duyệt, bước Kiểm tuỳ chọn", () => {
    const m = preset("aidlc-express");
    expect(m).toMatchObject({ method: "aidlc", blocking: "hard", sizes: ["M"] });
    expect(m.phases.map((p) => p.kind)).toEqual(["requirements", "implementation", "verification"]);
    const req = phaseOf(m, "requirements");
    const gates = req.gate.flatMap((g) => g.gates);
    expect(gates[0]?.rules).toEqual(["sections", "requirements", "no-open-questions"]);
    expect(gates[1]).toMatchObject({ id: "po", kind: "human" });
    expect(gates[1]?.reviewers?.roles).toContain("team-ba");
    expect(req.perProjectGates).toEqual(["po"]);
    for (const p of m.phases) expect(p.autoApprove).toBeUndefined();
    expect(phaseOf(m, "verify")).toMatchObject({ optional: true });
    expect(artifactsOf(m).find((a) => a.id === "test-results")?.required).toBe(false);
    expect(m.decomposition).toMatchObject({ granularity: "single", requirementId: "REQ-\\d+" });
  });

  it("speckit: nặng, Specify không tự duyệt, Plan và Tasks tự duyệt từ 9, cổng theo đội, contract ở Plan", () => {
    const m = preset("speckit");
    expect(m).toMatchObject({ method: "speckit", blocking: "hard", sizes: ["M", "L"] });
    expect(isHeavySdlc(m.sizes)).toBe(true);
    expect(m.phases.map((p) => p.id)).toEqual(["specify", "plan", "tasks", "implement", "converge"]);

    const specify = phaseOf(m, "specify");
    expect(specify.kind).toBe("requirements");
    expect(specify.autoApprove).toBeUndefined();

    for (const id of ["plan", "tasks"]) {
      const p = phaseOf(m, id);
      expect(p.autoApprove, id).toEqual({ gates: ["lead"], minScore: 9, revokeHours: 24 });
      expect(p.perProjectGates, id).toEqual(["lead"]);
      const kinds = p.gate.flatMap((g) => g.gates).map((g) => g.kind);
      expect(kinds.indexOf("ai"), id).toBeLessThan(kinds.indexOf("human"));
    }
    expect(phaseOf(m, "plan").artifacts.some((a) => a.scope === "contract")).toBe(true);
    expect(phaseOf(m, "plan").gate[0]?.gates.find((g) => g.kind === "ai")?.id).toBe("ai-plan");

    const tasksRules = phaseOf(m, "tasks").gate[0]?.gates[0];
    expect(tasksRules?.rules).toEqual(["breakdown", "coverage"]);
    const steps = phaseOf(m, "tasks").steps.map((s) => s.action);
    expect(steps).toEqual(["draft", "analyze"]);
    expect(m.decomposition).toMatchObject({
      parser: "speckit-tasks",
      granularity: "heading",
      requirementId: "FR-\\d{3}",
      requirementSource: [{ phase: "specify", artifact: "spec" }],
    });
    expect(m.converge.maxRounds).toBeGreaterThan(0);
  });

  it("khuôn tasks.md của speckit có ví dụ thẻ dự án mà không thành task thật", () => {
    const tasks = artifactsOf(preset("speckit")).find((a) => a.id === "tasks")?.template ?? "";
    expect(tasks).toMatch(/\[@[a-z0-9-]+\]/);
    // Dòng ví dụ nằm trong chú thích: không có dòng task nào mang thẻ dự án (khoá lạ làm bản tách lỗi).
    const taskLines = tasks.split("\n").filter((l) => /^\s*-\s*\[[ xX]\]\s*T\d+/.test(l));
    expect(taskLines.length).toBeGreaterThan(0);
    expect(taskLines.some((l) => l.includes("[@"))).toBe(false);
    expect(tasks).toMatch(/## Phase/);
  });

  it("tất cả cổng người của preset dùng vai trò có trong hệ thống", () => {
    for (const id of MVP)
      for (const p of preset(id).phases)
        for (const g of p.gate.flatMap((x) => x.gates).filter((x) => x.kind === "human"))
          expect(g.reviewers?.roles.length, `${id}/${p.id}/${g.id}`).toBeGreaterThan(0);
  });
});
