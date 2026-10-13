import { codeScope } from "@xdev-hive/contracts";
import { describe, expect, it } from "vitest";
import { type MatchCandidate, type MatchRun, matchCodeWorkflow, scopeMatches } from "./match.ts";

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER_TEAM = "22222222-2222-4222-8222-222222222222";

const run = (over: Partial<MatchRun> = {}): MatchRun => ({
  teamId: TEAM,
  projectKey: "payment-api",
  baseBranch: "main",
  defaultBranch: "main",
  taskType: "feature",
  changedFiles: ["src/payments/refund.ts", "README.md"],
  ...over,
});

const wf = (
  id: string,
  over: { teamId?: string | null; scope?: Record<string, unknown>; updatedAt?: string } = {},
): MatchCandidate => ({
  id,
  name: `Quy trình ${id}`,
  teamId: over.teamId ?? null,
  scope: codeScope.parse(over.scope ?? {}),
  updatedAt: new Date(over.updatedAt ?? "2026-10-01T00:00:00Z"),
});

describe("phạm vi quy trình code", () => {
  it("phạm vi rỗng chỉ khớp nhánh mặc định", () => {
    expect(scopeMatches(codeScope.parse({}), run(), null).matches).toBe(true);
    const v = scopeMatches(codeScope.parse({}), run({ baseBranch: "release/1.0" }), null);
    expect(v.matches).toBe(false);
    expect(v.reason).toContain("nhánh mặc định");
  });

  it("nhánh đích theo glob, thay cho nhánh mặc định", () => {
    const scope = codeScope.parse({ baseBranches: ["release/*"] });
    expect(scopeMatches(scope, run({ baseBranch: "release/1.0" }), null).matches).toBe(true);
    expect(scopeMatches(scope, run(), null).matches).toBe(false);
  });

  it("lọc theo dự án và loại task", () => {
    expect(scopeMatches(codeScope.parse({ projects: ["other"] }), run(), null).matches).toBe(false);
    expect(scopeMatches(codeScope.parse({ projects: ["payment-api"] }), run(), null).matches).toBe(true);
    expect(scopeMatches(codeScope.parse({ taskTypes: ["bug"] }), run(), null).matches).toBe(false);
    // Run không có loại task không khớp quy trình giới hạn loại.
    expect(scopeMatches(codeScope.parse({ taskTypes: ["bug"] }), run({ taskType: null }), null).matches).toBe(false);
  });

  it("đường dẫn đổi: cần một file khớp, thiếu số liệu thì coi như khớp", () => {
    const scope = codeScope.parse({ paths: ["src/payments/**"] });
    expect(scopeMatches(scope, run(), null).matches).toBe(true);
    expect(scopeMatches(scope, run({ changedFiles: ["docs/a.md"] }), null).matches).toBe(false);
    const unknown = scopeMatches(scope, run({ changedFiles: null }), null);
    expect(unknown.matches).toBe(true);
    expect(unknown.reason).toContain("Chưa biết file đổi");
  });

  it("quy trình của đội khác không bao giờ khớp", () => {
    const v = scopeMatches(codeScope.parse({}), run(), OTHER_TEAM);
    expect(v.matches).toBe(false);
    expect(scopeMatches(codeScope.parse({}), run(), TEAM).matches).toBe(true);
  });
});

describe("chọn quy trình code", () => {
  it("không có quy trình khớp thì không chọn gì", () => {
    const r = matchCodeWorkflow([wf("a", { scope: { projects: ["other"] } })], run());
    expect(r.chosen).toBeNull();
    expect(r.outranked).toEqual([]);
  });

  it("liệt kê dự án thắng của đội, của đội thắng của tổ chức; trả cả quy trình bị lấn", () => {
    const org = wf("org");
    const team = wf("team", { teamId: TEAM });
    const project = wf("project", { scope: { projects: ["payment-api"] } });
    const r = matchCodeWorkflow([org, team, project], run());
    expect(r.chosen?.id).toBe("project");
    expect(r.outranked.map((w) => w.id)).toEqual(["team", "org"]);
  });

  it("quy trình liệt kê dự án thắng dù thuộc tổ chức, đội thắng khi cùng không liệt kê dự án", () => {
    const orgProject = wf("org-project", { scope: { projects: ["payment-api"] } });
    const team = wf("team", { teamId: TEAM });
    expect(matchCodeWorkflow([team, orgProject], run()).chosen?.id).toBe("org-project");
    expect(matchCodeWorkflow([wf("org"), team], run()).chosen?.id).toBe("team");
  });

  it("cùng mức thì cập nhật gần nhất thắng, kết quả không phụ thuộc thứ tự đầu vào", () => {
    const older = wf("older", { updatedAt: "2026-09-01T00:00:00Z" });
    const newer = wf("newer", { updatedAt: "2026-10-10T00:00:00Z" });
    expect(matchCodeWorkflow([older, newer], run()).chosen?.id).toBe("newer");
    expect(matchCodeWorkflow([newer, older], run()).chosen?.id).toBe("newer");
  });

  it("bỏ quy trình không khớp phạm vi khỏi cả danh sách bị lấn", () => {
    const release = wf("release", { scope: { baseBranches: ["release/*"] } });
    const r = matchCodeWorkflow([release, wf("default")], run());
    expect(r.chosen?.id).toBe("default");
    expect(r.outranked).toEqual([]);
  });

  it("bản nháp chưa lưu (id null) vẫn được chọn", () => {
    const draft: MatchCandidate = { ...wf("x"), id: null, name: "Nháp" };
    expect(matchCodeWorkflow([draft], run()).chosen?.name).toBe("Nháp");
  });
});
