import { describe, expect, it } from "vitest";
import { contract } from "./index.ts";
import {
  QA_ERRORS,
  QA_STATUS_SEVERITY,
  qaErrorMessage,
  TEST_MANUAL_STATUS_LABEL,
  TEST_READ_STATE_LABEL,
  testAreaCode,
  testCaseCode,
  testCaseListInput,
  testCiSourceCreateInput,
  testCurrentStatus,
  testManualStatus,
  testProjectSettingsInput,
  testRecordInput,
  testRequirementCode,
  testRoundCreateInput,
  testRoundCreateNextInput,
  testSettingsInput,
} from "./testing.ts";

const id = "6f9619ff-8b86-4011-b42d-00c04fc964ff";

describe("mã", () => {
  it("mã khu 2–16 chữ hoa hoặc số, bắt đầu bằng chữ", () => {
    for (const ok of ["DN", "DANGNHAP", "OPD02", "A".repeat(16)])
      expect(testAreaCode.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["D", "dangnhap", "1DN", "DANG-NHAP", "A".repeat(17)])
      expect(testAreaCode.safeParse(bad).success, bad).toBe(false);
  });

  it("mã TC có khu và 3–5 chữ số", () => {
    for (const ok of ["TC-DANGNHAP-001", "TC-DN-12345"]) expect(testCaseCode.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["TC-001", "TC-dn-001", "TC-DN-01", "TC-DN-123456", "DN-001"])
      expect(testCaseCode.safeParse(bad).success, bad).toBe(false);
  });

  it("mã yêu cầu nhận mã spec và mã SRS (D10)", () => {
    for (const ok of ["FR-001", "036/AC-012.2", "NFR-0001", "US-010", "OPD02", "OPD02P00108", "USR01", "ACC"])
      expect(testRequirementCode.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["FR001", "NFR", "FR-01", "AC", "opd02", "OPD-02", "SC-001", "36/FR-001"])
      expect(testRequirementCode.safeParse(bad).success, bad).toBe(false);
  });
});

describe("QA_ERRORS", () => {
  it("đủ 12 mã, mỗi mã có câu tiếng Việt", () => {
    expect(Object.keys(QA_ERRORS)).toHaveLength(12);
    for (const [code, e] of Object.entries(QA_ERRORS)) expect(e.message, code).toMatch(/[ạ-ỹà-ýđ]/i);
  });

  it("điền khuôn và giữ khuôn khi thiếu giá trị", () => {
    expect(qaErrorMessage("QA_AREA_CODE_TAKEN", { KHU: "DN", "đường dẫn": "test-cases/dn.md" })).toBe(
      "Mã khu `DN` đã dùng ở `test-cases/dn.md`. Chọn mã khu khác.",
    );
    expect(qaErrorMessage("QA_FAILED_STEP_INVALID", { n: 4 })).toBe("Bước lỗi phải từ 1 tới 4.");
    expect(qaErrorMessage("QA_SOURCE_LABEL_TAKEN")).toContain("{nhãn}");
  });
});

describe("trạng thái", () => {
  it("mỗi trạng thái có chữ giao diện", () => {
    for (const s of testManualStatus.options) expect(TEST_MANUAL_STATUS_LABEL[s]).toBeTruthy();
    expect(Object.keys(TEST_READ_STATE_LABEL)).toHaveLength(6);
  });

  it("thứ tự xấu dần phủ mọi trạng thái hiện tại, failed xấu nhất", () => {
    expect([...QA_STATUS_SEVERITY].sort()).toEqual([...testCurrentStatus.options].sort());
    expect(QA_STATUS_SEVERITY.at(-1)).toBe("failed");
  });
});

describe("cài đặt", () => {
  it("thời hạn giữ 90–3650 ngày", () => {
    expect(testSettingsInput.safeParse({ retentionDays: 90 }).success).toBe(true);
    expect(testSettingsInput.safeParse({ retentionDays: 3650 }).success).toBe(true);
    expect(testSettingsInput.safeParse({ retentionDays: 89 }).success).toBe(false);
    expect(testSettingsInput.safeParse({ retentionDays: 3651 }).success).toBe(false);
  });

  it("thư mục TC tương đối, kết thúc bằng /, không ..", () => {
    const tcDir = (v: string) => testProjectSettingsInput.safeParse({ projectKey: "web", tcDir: v }).success;
    expect(tcDir("test-cases/")).toBe(true);
    expect(tcDir("qa/test-cases/")).toBe(true);
    for (const bad of ["test-cases", "/test-cases/", "../x/", "a/../b/", "a\\b/", "a//", `${"a".repeat(200)}/`])
      expect(tcDir(bad), bad).toBe(false);
  });
});

describe("thư viện", () => {
  it("danh sách mặc định TC đang dùng, 20 dòng, nhận limit dạng chuỗi", () => {
    const input = testCaseListInput.parse({ projectKey: "web" });
    expect(input.state).toBe("active");
    expect(input.limit).toBe(20);
    expect(testCaseListInput.parse({ projectKey: "web", limit: "100" }).limit).toBe(100);
    expect(testCaseListInput.safeParse({ projectKey: "web", limit: 101 }).success).toBe(false);
    expect(testCaseListInput.safeParse({ projectKey: "web", cursor: "x".repeat(2001) }).success).toBe(false);
  });
});

describe("nguồn CI", () => {
  const base = { projectKey: "web", label: "E2E", repoPath: "nhom/web", credential: "gitlab-ci" };

  it("mode artifact cần đường dẫn artifact tương đối", () => {
    expect(testCiSourceCreateInput.safeParse({ ...base, mode: "pipeline-report" }).success).toBe(true);
    expect(testCiSourceCreateInput.safeParse({ ...base, mode: "junit-artifact" }).success).toBe(false);
    expect(
      testCiSourceCreateInput.safeParse({ ...base, mode: "junit-artifact", artifactPath: "reports/junit.xml" }).success,
    ).toBe(true);
    expect(
      testCiSourceCreateInput.safeParse({ ...base, mode: "playwright-artifact", artifactPath: "../x.json" }).success,
    ).toBe(false);
  });

  it("đường dẫn repo có nhóm", () => {
    expect(testCiSourceCreateInput.safeParse({ ...base, mode: "pipeline-report", repoPath: "web" }).success).toBe(
      false,
    );
  });
});

describe("đợt test", () => {
  const round = { projectKey: "web", name: "Đợt 1", environment: "staging", build: "1.2.0" };

  it("ngày kết thúc không trước ngày bắt đầu", () => {
    const parse = (startDate: string, plannedEndDate: string) =>
      testRoundCreateInput.safeParse({ ...round, startDate, plannedEndDate, select: { areas: ["DN"] } }).success;
    expect(parse("2026-10-24", "2026-10-24")).toBe(true);
    expect(parse("2026-10-24", "2026-10-23")).toBe(false);
  });

  it("đợt tiếp theo mặc định chuyển failed, untested, deferred, other", () => {
    const next = testRoundCreateNextInput.parse({
      fromRoundId: id,
      name: "Đợt 2",
      environment: "",
      build: "",
      startDate: "2026-10-25",
      plannedEndDate: "2026-10-30",
    });
    expect(next.statuses).toEqual(["failed", "untested", "deferred", "other"]);
  });

  it("Không đạt và Khác cần ghi chú hoặc liên kết", () => {
    const record = (r: object) => testRecordInput.safeParse({ roundCaseId: id, revision: 0, ...r });
    expect(record({ status: "passed" }).success).toBe(true);
    const missing = record({ status: "failed" });
    expect(missing.success).toBe(false);
    expect(missing.error?.issues[0]?.message).toBe(QA_ERRORS.QA_NOTE_REQUIRED.message);
    expect(record({ status: "other", note: "Môi trường lỗi" }).success).toBe(true);
    expect(record({ status: "failed", links: ["https://gitlab.example.com/x/-/issues/1"] }).success).toBe(true);
  });

  it("liên kết http(s), tối đa 5, ghi chú tối đa 500", () => {
    const record = (r: object) => testRecordInput.safeParse({ roundCaseId: id, revision: 0, status: "passed", ...r });
    expect(record({ links: ["ftp://x"] }).success).toBe(false);
    expect(record({ links: [`https://x/${"a".repeat(2000)}`] }).success).toBe(false);
    expect(record({ links: Array.from({ length: 6 }, (_, i) => `https://x/${i}`) }).success).toBe(false);
    expect(record({ note: "a".repeat(501) }).success).toBe(false);
  });
});

describe("hợp đồng", () => {
  type Proc = { "~orpc": { route: { method?: string; path?: string; summary?: string; tags?: string[] } } };
  const groups = {
    settings: ["get", "update"],
    projectSettings: ["get", "update"],
    areas: ["list", "create"],
    cases: ["list", "get", "history"],
    sources: ["list", "create", "update", "delete", "refetch", "runs"],
    rounds: [
      "list",
      "get",
      "create",
      "createNext",
      "assign",
      "record",
      "history",
      "close",
      "reopen",
      "deleteNote",
      "export",
    ],
    myWork: ["list"],
    dashboard: ["overview", "areas", "requirements", "trend", "flaky"],
  } as const;

  it("đủ route dưới /v1/testing, mô tả tiếng Việt, đường dẫn không trùng", () => {
    const seen = new Set<string>();
    for (const [group, names] of Object.entries(groups)) {
      const g = contract.testing[group as keyof typeof groups] as unknown as Record<string, Proc>;
      expect(Object.keys(g).sort(), group).toEqual([...names].sort());
      for (const name of names) {
        const { method, path, summary, tags } = (g[name] as Proc)["~orpc"].route;
        expect(path, name).toMatch(/^\/v1\/testing\//);
        expect(tags, name).toEqual(["testing"]);
        expect(summary, name).toMatch(/[ạ-ỹà-ýđ]/i);
        const key = `${method} ${path}`;
        expect(seen.has(key), `${group}.${name}: ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });
});
