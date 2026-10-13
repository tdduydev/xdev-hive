import { ORPCError } from "@orpc/client";
import { defaultProjectSettings, type ProjectSettings } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { buildPatch, fieldOfPath, formFromSettings, saveErrors } from "@/lib/project-settings.ts";

const base = (): ProjectSettings => defaultProjectSettings(1);

describe("buildPatch: tiết kiệm token", () => {
  it("settings chưa có tokenSaving (hub cũ) hiện mặc định và không tạo bản vá", () => {
    const s = base();
    // biome-ignore lint/suspicious/noExplicitAny: mô phỏng hub cũ không gửi mục này
    delete (s as any).tokenSaving;
    const form = formFromSettings(s);
    expect(form).toMatchObject({
      tokenSaving: true,
      bashMaxChars: "15000",
      autocompactPct: "70",
      subagentModel: "sonnet",
      cacheTtl: "5m",
      rtk: true,
      codegraph: true,
    });
    expect(buildPatch(form, s)).toEqual({ ok: true, patch: null });
  });

  it("chỉ gửi mục tokenSaving khi đổi, đủ bảy trường", () => {
    const s = base();
    const form = { ...formFromSettings(s), cacheTtl: "1h" as const, bashMaxChars: " 20000 " };
    expect(buildPatch(form, s)).toEqual({
      ok: true,
      patch: {
        tokenSaving: {
          enabled: true,
          bashMaxChars: 20000,
          autocompactPct: 70,
          subagentModel: "sonnet",
          cacheTtl: "1h",
          autocompactWindow: 200000,
          allowWeb: false,
          rtk: true,
          codegraph: true,
        },
      },
    });
  });

  it("tắt RTK hoặc CodeGraph tạo bản vá và đọc lại đúng từ settings đã lưu", () => {
    const s = base();
    const form = { ...formFromSettings(s), rtk: false, codegraph: false };
    const r = buildPatch(form, s);
    expect(r).toMatchObject({ ok: true, patch: { tokenSaving: { rtk: false, codegraph: false } } });
    const saved: ProjectSettings = { ...s, tokenSaving: { ...s.tokenSaving, rtk: false, codegraph: false } };
    expect(formFromSettings(saved)).toMatchObject({ rtk: false, codegraph: false });
    expect(buildPatch(formFromSettings(saved), saved)).toEqual({ ok: true, patch: null });
  });

  it("hub cũ chưa gửi autocompactWindow/allowWeb: hiện mặc định, không tạo bản vá", () => {
    const s = base();
    // biome-ignore lint/suspicious/noExplicitAny: mô phỏng tokenSaving lưu trước khi có hai trường mới
    const { autocompactWindow: _a, allowWeb: _w, ...old } = s.tokenSaving as any;
    const form = formFromSettings({ ...s, tokenSaving: old });
    expect(form).toMatchObject({ autocompactWindow: "200000", allowWeb: false });
    expect(buildPatch(form, { ...s, tokenSaving: old })).toEqual({ ok: true, patch: null });
  });

  it("cửa sổ ngữ cảnh ngoài khoảng báo lỗi ở ô autocompactWindow", () => {
    const s = base();
    const r = buildPatch({ ...formFromSettings(s), autocompactWindow: "1000" }, s);
    expect(r).toMatchObject({ ok: false, errors: { autocompactWindow: "Tối thiểu 50.000 token." } });
  });
});

describe("buildPatch: định tuyến model", () => {
  it("settings chưa có routing (hub cũ) hiện mặc định và không tạo bản vá", () => {
    const s = base();
    // biome-ignore lint/suspicious/noExplicitAny: mô phỏng hub cũ không gửi mục này
    delete (s as any).routing;
    const form = formFromSettings(s);
    expect(form.routing).toBe(true);
    expect(form.tiers.heavy).toEqual({ model: "opus", effort: "high", maxTurns: "200", advisor: "" });
    expect(buildPatch(form, s)).toEqual({ ok: true, patch: null });
  });

  it("chỉ gửi mục routing khi đổi; advisor trống là null", () => {
    const s = base();
    const form = formFromSettings(s);
    form.tiers.medium = { ...form.tiers.medium, advisor: " opus ", maxTurns: "150" };
    const r = buildPatch(form, s);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.patch).toEqual({
      routing: {
        enabled: true,
        tiers: {
          light: { model: "sonnet", effort: "medium", maxTurns: 60, advisor: null },
          medium: { model: "sonnet", effort: "high", maxTurns: 150, advisor: "opus" },
          heavy: { model: "opus", effort: "high", maxTurns: 200, advisor: null },
        },
      },
    });
  });

  it("tắt định tuyến chỉ đổi cờ enabled", () => {
    const s = base();
    const r = buildPatch({ ...formFromSettings(s), routing: false }, s);
    expect(r.ok && r.patch?.routing?.enabled).toBe(false);
  });

  it("lỗi gắn vào ô của đúng cấp", () => {
    const s = base();
    const form = formFromSettings(s);
    form.tiers.light = { ...form.tiers.light, maxTurns: "0", model: " " };
    const r = buildPatch(form, s);
    expect(r).toMatchObject({
      ok: false,
      errors: { "tiers.light.maxTurns": "Tối thiểu 1 lượt.", "tiers.light.model": "Nhập tên model." },
    });
    const text = buildPatch({ ...form, tiers: { ...form.tiers, light: { ...form.tiers.light, maxTurns: "abc" } } }, s);
    expect(!text.ok && text.errors["tiers.light.maxTurns"]).toBe("Nhập một số, hoặc để trống.");
  });

  it("fieldOfPath đổi đường dẫn routing thành tên ô", () => {
    expect(fieldOfPath(["routing", "tiers", "heavy", "maxTurns"])).toBe("tiers.heavy.maxTurns");
    expect(fieldOfPath(["routing", "enabled"])).toBeUndefined();
    expect(fieldOfPath(["tokenSaving", "autocompactWindow"])).toBe("autocompactWindow");
  });

  it("số ngoài khoảng và tên model trống báo lỗi của hub ở đúng ô", () => {
    const s = base();
    const r = buildPatch({ ...formFromSettings(s), bashMaxChars: "500", subagentModel: "  " }, s);
    expect(r).toMatchObject({
      ok: false,
      errors: { bashMaxChars: "Tối thiểu 1.000 ký tự.", subagentModel: "Nhập tên model." },
    });
  });

  it("ô số trống hoặc là chữ báo lỗi ngay, không gửi", () => {
    const s = base();
    const empty = buildPatch({ ...formFromSettings(s), autocompactPct: "" }, s);
    expect(!empty.ok && empty.errors.autocompactPct).toBe("Nhập một số.");
    const text = buildPatch({ ...formFromSettings(s), autocompactPct: "abc" }, s);
    expect(!text.ok && text.errors.autocompactPct).toBe("Nhập một số, hoặc để trống.");
  });
});

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
        features: { planMode: false, crossReview: false, mergeQueue: true, sandbox: false },
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
    expect(r.ok && r.patch).toEqual({
      features: { planMode: false, crossReview: false, mergeQueue: false, sandbox: false },
    });
  });

  it("model và quyền CLI", () => {
    const s = base();
    const form = formFromSettings(s);
    form.models.claude.code = " claude-opus-5-5 ";
    form.models.antigravity.code = "gemini-3.8-flash-high";
    form.runPermissions = "full";
    const r = buildPatch(form, s);
    expect(r.ok && r.patch).toEqual({
      models: {
        claude: { code: "claude-opus-5-5", review: null },
        codex: { code: null, review: null },
        gemini: { code: null, review: null },
        antigravity: { code: "gemini-3.8-flash-high", review: null },
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

describe("brief", () => {
  it("form lấy mặc định khi hub cũ chưa có mục brief", () => {
    const { brief: _, ...old } = base();
    expect(formFromSettings(old as ProjectSettings)).toMatchObject({
      briefAuto: true,
      briefRefreshCommits: "50",
      briefRefreshDays: "7",
    });
  });

  it("đổi ngưỡng thì chỉ gửi mục brief", () => {
    const s = base();
    const form = { ...formFromSettings(s), briefAuto: false, briefRefreshCommits: "20" };
    expect(buildPatch(form, s)).toEqual({
      ok: true,
      patch: { brief: { auto: false, refreshCommits: 20, refreshDays: 7 } },
    });
  });

  it("ô trống về mặc định, số ngoài khoảng gắn lỗi vào ô", () => {
    const s = base();
    expect(buildPatch({ ...formFromSettings(s), briefRefreshDays: "" }, s)).toEqual({ ok: true, patch: null });
    const bad = buildPatch({ ...formFromSettings(s), briefRefreshDays: "400" }, s);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toHaveProperty("briefRefreshDays");
  });
});

describe("fieldOfPath", () => {
  it.each([
    [["merge", "requiredApprovals"], "requiredApprovals"],
    [["budget", "perRunUsd"], "perRunUsd"],
    [["models", "codex", "review"], "models.codex.review"],
    [["outcome", "default", 1, "when", "paths", 0], "reviewPaths"],
    [["outcome", "default", 1, "when"], "reviewMinLines"],
    [["brief", "auto"], "briefAuto"],
    [["brief", "refreshCommits"], "briefRefreshCommits"],
    [["brief", "refreshDays"], "briefRefreshDays"],
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
