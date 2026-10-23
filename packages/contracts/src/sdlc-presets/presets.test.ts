import { describe, expect, it } from "vitest";
import { type Breakdown, parseBreakdown } from "../breakdown.ts";
import {
  checkRepoPath,
  isHeavySdlc,
  renderRepoPath,
  type SdlcMode,
  sdlcMode,
  sdlcModeWarnings,
  sdlcSlug,
} from "../sdlc.ts";
import { isSdlcPresetId, SDLC_PRESET_IDS, SDLC_PRESETS, type SdlcPresetId } from "./index.ts";

const preset = (id: SdlcPresetId): SdlcMode => SDLC_PRESETS[id];

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

describe("preset", () => {
  it("có đủ mười ba preset, id khớp khoá và nằm trong danh sách preset", () => {
    expect(Object.keys(SDLC_PRESETS).sort()).toEqual([...SDLC_PRESET_IDS].sort());
    for (const id of SDLC_PRESET_IDS) {
      expect(preset(id).id).toBe(id);
      expect(isSdlcPresetId(id)).toBe(true);
      expect(SDLC_PRESET_IDS).toContain(id);
    }
  });

  it("mọi preset parse lại qua sdlcMode và không còn cảnh báo", () => {
    for (const id of SDLC_PRESET_IDS) {
      const again = sdlcMode.safeParse(preset(id));
      expect(again.success, id).toBe(true);
      expect(sdlcModeWarnings(preset(id)), id).toEqual([]);
    }
  });

  it("prompt chỉ dùng biến mà hub điền", () => {
    const allowed = new Set(["idea", "artifacts", "answers", "feedback", "constitution", "projects", "release"]);
    for (const id of SDLC_PRESET_IDS)
      for (const phase of preset(id).phases)
        for (const step of phase.steps)
          for (const [, name] of step.prompt.matchAll(/\{(\w+)\}/g))
            expect(allowed.has(name ?? ""), `${id}/${step.id}: {${name}}`).toBe(true);
  });

  it("khuôn có đủ mục bắt buộc, không mang sẵn dấu câu hỏi mở", () => {
    for (const id of SDLC_PRESET_IDS)
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
    for (const id of SDLC_PRESET_IDS)
      for (const phase of preset(id).phases) {
        const gates = phase.gate.flatMap((g) => g.gates).filter((g) => g.rules?.includes("sections"));
        const required = phase.artifacts.find((a) => a.required && a.sections.length);
        for (const g of gates) expect(g.sections, `${id}/${phase.id}`).toEqual(required?.sections);
      }
  });
});

describe("đường dẫn tài liệu", () => {
  it("điền {NNN}, {slug}, {date} cho dự án chính", () => {
    const paths = (id: SdlcPresetId) =>
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
    for (const id of SDLC_PRESET_IDS)
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
    expect(m.phases.map((p) => p.id)).toEqual(["specify", "plan", "tasks", "implement", "converge", "release"]);
    // US11: release notes rồi retro tự chạy khi hội tụ; hạng mục đóng khi người duyệt cả hai.
    const release = phaseOf(m, "release");
    expect(release).toMatchObject({ kind: "release", optional: true });
    expect(release.steps.map((s) => [s.action, s.auto])).toEqual([
      ["release-notes", true],
      ["retro", true],
    ]);
    expect(release.artifacts.every((a) => a.required)).toBe(true);
    expect(release.steps.every((s) => s.prompt.includes("{release}"))).toBe(true);
    expect(release.steps[1]?.prompt).toContain("`lessons`");

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
    for (const id of SDLC_PRESET_IDS)
      for (const p of preset(id).phases)
        for (const g of p.gate.flatMap((x) => x.gates).filter((x) => x.kind === "human"))
          expect(g.reviewers?.roles.length, `${id}/${p.id}/${g.id}`).toBeGreaterThan(0);
  });
});

describe("preset còn lại (T083)", () => {
  const ctx = { homeProject: "payment-api", projects: [] };
  const decomposed = (id: SdlcPresetId): Breakdown => {
    const m = preset(id);
    const d = m.decomposition;
    const template = artifactsOf(m).find((a) => a.id === d?.artifact)?.template;
    if (!d || !template) throw new Error(`Thiếu khuôn tách việc của ${id}`);
    const r = parseBreakdown(template, d, ctx);
    if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r.errors)}`);
    return r.breakdown;
  };

  it("khuôn tài liệu tách việc của mọi preset đọc được bằng bộ đọc của chính nó", () => {
    for (const id of SDLC_PRESET_IDS)
      if (preset(id).decomposition) expect(decomposed(id).tasks.length, id).toBeGreaterThan(0);
    expect(decomposed("aidlc-feature").tasks.map((t) => [t.sliceKey, t.dependsOn])).toEqual([
      ["unit-1", []],
      ["unit-2", ["unit-1"]],
    ]);
    expect(decomposed("bmad-method").tasks.map((t) => [t.sliceKey, t.dependsOn])).toEqual([
      ["1.1", []],
      ["1.2", ["1.1"]],
    ]);
    expect(decomposed("kiro-requirements").tasks.map((t) => [t.sliceKey, t.dependsOn, t.requirementIds])).toEqual([
      ["1", [], ["1.1"]],
      ["2", ["1"], ["1.2"]],
    ]);
    expect(decomposed("openspec").tasks.map((t) => [t.sliceKey, t.dependsOn])).toEqual([
      ["1", []],
      ["2", ["1"]],
    ]);
    expect(decomposed("bmad-quick").tasks[0]?.checklist).toHaveLength(2);
  });

  it("đường dẫn theo quy ước của từng phương pháp", () => {
    const paths = (id: SdlcPresetId) =>
      Object.fromEntries(
        artifactsOf(preset(id)).map((a) => [a.id, renderRepoPath(a.path, { ...VARS, name: "x", format: "openapi" })]),
      );
    const intent = "aidlc/spaces/default/intents/2026-10-14-hoan-tien-mot-phan";
    expect(paths("aidlc-feature")).toMatchObject({
      intent: `${intent}/ideation/intent.md`,
      units: `${intent}/inception/units-generation/unit-of-work.md`,
      runbook: `${intent}/operation/runbook.md`,
    });
    expect(paths("aidlc-enterprise").nfr).toBe(`${intent}/inception/nfr-requirements/nfr-requirements.md`);
    expect(paths("bmad-quick")).toEqual({ spec: "specs/spec-hoan-tien-mot-phan/SPEC.md" });
    expect(paths("bmad-method")).toMatchObject({
      prd: "_bmad-output/planning-artifacts/hoan-tien-mot-phan/prd.md",
      epics: "_bmad-output/planning-artifacts/hoan-tien-mot-phan/epics.md",
    });
    expect(paths("kiro-requirements")).toEqual({
      requirements: ".kiro/specs/hoan-tien-mot-phan/requirements.md",
      design: ".kiro/specs/hoan-tien-mot-phan/design.md",
      contract: ".kiro/specs/hoan-tien-mot-phan/contracts/x.yaml",
      tasks: ".kiro/specs/hoan-tien-mot-phan/tasks.md",
    });
    expect(paths("kiro-bugfix")).toEqual({
      bugfix: ".kiro/specs/hoan-tien-mot-phan/bugfix.md",
      tasks: ".kiro/specs/hoan-tien-mot-phan/tasks.md",
    });
    expect(paths("openspec")).toMatchObject({
      proposal: "openspec/changes/hoan-tien-mot-phan/proposal.md",
      "delta-spec": "openspec/changes/hoan-tien-mot-phan/specs/hoan-tien-mot-phan/spec.md",
      "living-spec": "openspec/specs/hoan-tien-mot-phan/spec.md",
    });
  });

  it("tự duyệt và cổng theo dự án theo bảng mặc định của plan.md", () => {
    const auto = (id: SdlcPresetId) =>
      Object.fromEntries(
        preset(id)
          .phases.filter((p) => p.autoApprove)
          .map((p) => [p.id, p.autoApprove?.minScore]),
      );
    expect(auto("aidlc-feature")).toEqual({ units: 9 });
    expect(auto("aidlc-enterprise")).toEqual({});
    expect(auto("bmad-method")).toEqual({ epics: 9 });
    expect(auto("bmad-quick")).toEqual({});
    for (const id of ["kiro-requirements", "kiro-design", "kiro-bugfix", "openspec"] as const)
      expect(auto(id), id).toEqual({ tasks: 9 });
    // Chế độ nặng: không giai đoạn yêu cầu nào tự duyệt.
    for (const id of SDLC_PRESET_IDS)
      if (isHeavySdlc(preset(id).sizes))
        for (const p of preset(id).phases.filter((x) => x.kind === "requirements"))
          expect(p.autoApprove, `${id}/${p.id}`).toBeUndefined();
    expect(phaseOf(preset("aidlc-feature"), "design").perProjectGates).toEqual(["lead"]);
    expect(phaseOf(preset("kiro-requirements"), "design").perProjectGates).toEqual(["lead"]);
  });

  it("contract ở thiết kế của aidlc, bmad-method, kiro-requirements, openspec; kiro-design và kiro-bugfix thì không", () => {
    const contractPhase = (id: SdlcPresetId) =>
      preset(id).phases.find((p) => p.artifacts.some((a) => a.scope === "contract"))?.kind ?? null;
    for (const id of ["aidlc-feature", "aidlc-enterprise", "bmad-method", "kiro-requirements", "openspec"] as const)
      expect(contractPhase(id), id).toBe("design");
    expect(contractPhase("kiro-design")).toBeNull();
    expect(contractPhase("kiro-bugfix")).toBeNull();
  });

  it("aidlc-enterprise: Pháp chế và Bảo mật theo từ khoá, thiết kế cần hai người", () => {
    const m = preset("aidlc-enterprise");
    const req = phaseOf(m, "requirements").gate.flatMap((g) => g.gates);
    expect(req.find((g) => g.id === "legal")?.conditions.keywords).toContain("hoàn tiền");
    expect(req.find((g) => g.id === "security")?.reviewers?.roles).toEqual(["org-admin"]);
    expect(phaseOf(m, "design").gate[0]?.gates.find((g) => g.id === "lead")?.reviewers?.quorum).toBe(2);
    expect(m.decomposition?.requirementSource.map((s) => s.artifact)).toEqual(["requirements", "nfr"]);
  });

  it("kiro: requirements kiểm EARS, thứ tự giai đoạn theo biến thể, bugfix chặn mềm", () => {
    expect(phaseOf(preset("kiro-requirements"), "requirements").gate[0]?.gates[0]?.rules).toContain("ears");
    expect(preset("kiro-requirements").phases.map((p) => p.id)).toEqual([
      "requirements",
      "design",
      "tasks",
      "implement",
    ]);
    expect(preset("kiro-design").phases.map((p) => p.id)).toEqual(["design", "requirements", "tasks", "implement"]);
    expect(preset("kiro-bugfix")).toMatchObject({ blocking: "soft", decomposition: { parser: "kiro-tasks" } });
    const re = new RegExp(preset("kiro-requirements").decomposition?.requirementId ?? "", "g");
    expect("1.1, 2.3 nhưng không 1.2.3".match(re)).toEqual(["1.1", "2.3"]);
  });

  it("openspec: bước archive ở giai đoạn phát hành, không tự chạy", () => {
    const archive = phaseOf(preset("openspec"), "archive");
    expect(archive).toMatchObject({ kind: "release", optional: true });
    expect(archive.steps[0]).toMatchObject({
      action: "archive",
      auto: false,
      artifacts: ["delta-spec", "living-spec"],
    });
    expect(preset("openspec").decomposition).toMatchObject({ parser: "openspec-tasks", granularity: "heading" });
  });
});
