import { ORPCError } from "@orpc/client";
import { defaultProjectSettings, type ProjectSettings } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { buildPatch, fieldOfPath, formFromSettings, saveErrors } from "./project-settings.ts";

const base = (): ProjectSettings => defaultProjectSettings(1);

describe("buildPatch", () => {
  it("không đổi gì thì không có bản vá", () => {
    const s = base();
    expect(buildPatch(formFromSettings(s), s)).toEqual({ ok: true, patch: null });
  });

  it("chỉ gửi mục đã đổi", () => {
    const s = base();
    const form = { ...formFromSettings(s), mergeQueue: true, perRunUsd: "2,5" };
    expect(buildPatch(form, s)).toEqual({
      ok: true,
      patch: {
        features: { planMode: false, crossReview: false, mergeQueue: true },
        budget: { perRunUsd: 2.5, perTaskUsd: null, maxTurns: null },
      },
    });
  });

  it("bật review chéo thêm bước review vào chính sách mặc định, có điều kiện when", () => {
    const s = base();
    const form = {
      ...formFromSettings(s),
      crossReview: true,
      reviewBy: "claude" as const,
      reviewMinLines: "40",
      reviewPaths: "src/billing/**\n\n  db/** ",
    };
    const r = buildPatch(form, s);
    expect(r.ok && r.patch?.outcome?.default).toEqual([
      { check: "changes", required: true },
      {
        check: "review",
        by: "claude",
        required: true,
        minScore: 7,
        when: { minChangedLines: 40, paths: ["src/billing/**", "db/**"] },
      },
    ]);
  });

  it("sửa bước review đã có tại chỗ, bỏ when khi để trống cả hai ô", () => {
    const s = base();
    s.features.crossReview = true;
    s.outcome.default = [
      { check: "review", by: "codex", required: false, minScore: 6, when: { minChangedLines: 10 } },
      { check: "changes", required: true },
    ];
    const form = { ...formFromSettings(s), reviewMinLines: "", reviewMinScore: "8" };
    const r = buildPatch(form, s);
    expect(r.ok && r.patch?.outcome?.default).toEqual([
      { check: "review", by: "codex", required: false, minScore: 8 },
      { check: "changes", required: true },
    ]);
  });

  it("tắt review chéo giữ nguyên bước review", () => {
    const s = base();
    s.features.crossReview = true;
    s.outcome.default = [{ check: "review", by: "codex", required: true, minScore: 7 }];
    const r = buildPatch({ ...formFromSettings(s), crossReview: false }, s);
    expect(r.ok && r.patch).toEqual({ features: { planMode: false, crossReview: false, mergeQueue: false } });
  });

  it("model và quyền CLI", () => {
    const s = base();
    const form = formFromSettings(s);
    form.models.claude.code = " claude-opus-5-5 ";
    form.runPermissions = "full";
    const r = buildPatch(form, s);
    expect(r.ok && r.patch).toEqual({
      models: {
        claude: { code: "claude-opus-5-5", review: null },
        codex: { code: null, review: null },
        gemini: { code: null, review: null },
      },
      runPermissions: { mode: "full" },
    });
  });

  it("gắn lỗi của zod vào đúng ô", () => {
    const s = base();
    const r = buildPatch(
      {
        ...formFromSettings(s),
        requiredApprovals: "9",
        perTaskUsd: "-1",
        maxTurns: "1.5",
        crossReview: true,
        reviewMinScore: "11",
      },
      s,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["maxTurns", "perTaskUsd", "requiredApprovals", "reviewMinScore"]);
  });

  it("chữ trong ô số báo lỗi tiếng Việt", () => {
    const s = base();
    const r = buildPatch({ ...formFromSettings(s), perRunUsd: "năm" }, s);
    expect(r).toEqual({ ok: false, errors: { perRunUsd: "Nhập một số, hoặc để trống." } });
  });
});

describe("fieldOfPath", () => {
  it.each([
    [["merge", "requiredApprovals"], "requiredApprovals"],
    [["budget", "perRunUsd"], "perRunUsd"],
    [["models", "codex", "review"], "models.codex.review"],
    [["outcome", "default", 1, "when", "paths", 0], "reviewPaths"],
    [["outcome", "default", 1, "when"], "reviewMinLines"],
    [["features", "planMode"], undefined],
  ] as const)("%j → %s", (path, field) => expect(fieldOfPath(path)).toBe(field));
});

describe("saveErrors", () => {
  it("BAD_REQUEST của hub gắn theo đường dẫn settings.*", () => {
    const error = new ORPCError("BAD_REQUEST", {
      data: { issues: [{ path: ["settings", "budget", "maxTurns"], message: "Quá lớn" }] },
    });
    expect(saveErrors(error)).toEqual({ errors: { maxTurns: "Quá lớn" } });
  });

  it("lỗi khác hiện chung", () => {
    const error = new ORPCError("FORBIDDEN", { defined: true, message: "Cần vai trò quản trị của đội trở lên." });
    expect(saveErrors(error)).toEqual({ errors: {}, message: "Cần vai trò quản trị của đội trở lên." });
  });
});
