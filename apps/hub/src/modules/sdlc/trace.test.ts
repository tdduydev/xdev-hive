import { describe, expect, it } from "vitest";
import { buildTrace, requirementTexts, type TraceLinkRow, type TraceTaskInput, traceCsv } from "./trace.ts";

const projects = [
  { id: "pa", key: "API" },
  { id: "pw", key: "WEB" },
];

const task = (taskId: string, projectId: string, status: TraceTaskInput["status"], reqs: string[]): TraceTaskInput => ({
  taskId,
  key: taskId.toUpperCase(),
  projectId,
  projectKey: projectId === "pa" ? "API" : "WEB",
  status,
  requirementIds: reqs,
});

const link = (requirementId: string, kind: string, ref: string, taskId: string | null, data = {}): TraceLinkRow => ({
  requirementId,
  kind,
  ref,
  taskId,
  runId: kind === "run" ? ref : null,
  data,
});

/*
 * Bộ mẫu SC-006: năm requirement, hai dự án.
 * FR-001: a1 (API) xong có test, w1 (WEB) xong CI xanh → kế hoạch, đã làm, đã kiểm.
 * FR-002: a2 xong không test, CI đỏ → kế hoạch, đã làm.
 * FR-003: w2 đang review → kế hoạch.
 * FR-004: không có task.
 * FR-005: a2 xong không chứng minh, nhưng converge vòng gần nhất `met` → đã kiểm.
 */
const input = {
  itemId: "item",
  requirements: [
    { id: "FR-001", text: "Xuất CSV" },
    { id: "FR-002", text: "Tổng hợp" },
    { id: "FR-003", text: "Lịch" },
    { id: "FR-004", text: "Gửi mail" },
    { id: "FR-005", text: "Phân quyền" },
  ],
  tasks: [
    task("a1", "pa", "done", ["FR-001"]),
    task("a2", "pa", "done", ["FR-002", "FR-005"]),
    task("w1", "pw", "done", ["FR-001"]),
    task("w2", "pw", "review", ["FR-003"]),
  ],
  links: [
    link("FR-001", "run", "r-old", "a1"),
    link("FR-001", "run", "r1", "a1"),
    link("FR-001", "pr", "https://git/pull/1", "a1"),
    link("FR-001", "commit", "abc", "a1"),
    link("FR-001", "test", "csv.test.ts", "a1"),
    link("FR-001", "ci", "def", "w1", { state: "success" }),
    link("FR-002", "ci", "ghi", "a2", { state: "failure" }),
    link("FR-005", "finding", "f1", null, { status: "partial", evidence: "thiếu", round: 1 }),
    link("FR-005", "finding", "f2", null, { status: "met", evidence: "đủ", round: 2 }),
  ],
  projects,
};

describe("buildTrace (SC-006)", () => {
  it("độ phủ ba mức tổng đúng trên bộ mẫu", () => {
    const t = buildTrace(input);
    expect(t.rows.map((r) => [r.requirementId, r.planned, r.done, r.verified])).toEqual([
      ["FR-001", true, true, true],
      ["FR-002", true, true, false],
      ["FR-003", true, false, false],
      ["FR-004", false, false, false],
      ["FR-005", true, true, true],
    ]);
    expect(t.total).toEqual({ requirements: 5, planned: 80, done: 60, verified: 40 });
  });

  it("độ phủ theo dự án: mẫu số là mọi requirement, tử số chỉ xét task của dự án", () => {
    const t = buildTrace(input);
    expect(t.byProject).toEqual([
      // API: FR-001, 002, 005 có task, đều xong; đã kiểm FR-001 (test) và FR-005 (converge).
      { projectKey: "API", coverage: { requirements: 5, planned: 60, done: 60, verified: 40 } },
      // WEB: FR-001 (xong, CI xanh), FR-003 (đang review).
      { projectKey: "WEB", coverage: { requirements: 5, planned: 40, done: 20, verified: 20 } },
    ]);
  });

  it("ô task lấy run mới nhất, PR, commit, test, CI; lọc theo dự án chỉ giữ task của dự án đó", () => {
    const t = buildTrace(input);
    const fr1 = t.rows[0];
    expect(fr1?.tasks[0]).toEqual({
      taskId: "a1",
      key: "A1",
      projectKey: "API",
      status: "done",
      runId: "r1",
      prUrl: "https://git/pull/1",
      mergeSha: "abc",
      tests: ["csv.test.ts"],
      ci: "none",
    });
    expect(fr1?.tasks[1]?.ci).toBe("success");
    expect(t.rows[4]?.findings.map((f) => f.status)).toEqual(["partial", "met"]);

    const web = buildTrace({ ...input, projectId: "pw" });
    expect(web.rows.flatMap((r) => r.tasks.map((x) => x.taskId))).toEqual(["w1", "w2"]);
    expect(web.byProject.map((p) => p.projectKey)).toEqual(["WEB"]);
    expect(web.total).toEqual({ requirements: 5, planned: 40, done: 20, verified: 20 });
  });

  it("requirement chỉ có trong task vẫn thành dòng; không có requirement thì độ phủ 0", () => {
    const t = buildTrace({ ...input, requirements: [], links: [] });
    expect(t.rows.map((r) => r.requirementId)).toEqual(["FR-001", "FR-002", "FR-005", "FR-003"]);
    expect(buildTrace({ ...input, requirements: [], tasks: [], links: [] }).total).toEqual({
      requirements: 0,
      planned: 0,
      done: 0,
      verified: 0,
    });
  });
});

describe("traceCsv", () => {
  it("một dòng mỗi (requirement, task) có cột dự án; requirement chưa có task vẫn có dòng; chặn công thức", () => {
    const t = buildTrace({
      ...input,
      requirements: [...input.requirements.slice(0, 4), { id: "FR-005", text: '=HYPERLINK("x")' }],
    });
    const lines = traceCsv(t).trimEnd().split("\r\n");
    expect(lines[0]).toBe("requirement,nội dung,dự án,task,trạng thái,run,PR,commit,test,CI,kế hoạch,đã làm,đã kiểm");
    expect(lines).toHaveLength(1 + 2 + 1 + 1 + 1 + 1);
    expect(lines[1]).toBe("FR-001,Xuất CSV,API,A1,done,r1,https://git/pull/1,abc,csv.test.ts,none,có,có,có");
    expect(lines.find((l) => l.startsWith("FR-004"))).toBe("FR-004,Gửi mail,,,,,,,,,không,không,không");
    expect(lines.at(-1)).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("requirementTexts", () => {
  it("câu chữ là dòng đầu nêu mã, bỏ dấu đầu dòng", () => {
    const spec = "# Spec\n\n- **FR-001**: Hệ thống MUST xuất CSV.\n1. FR-002 tổng hợp\n\nNhắc lại FR-001 ở đây.";
    expect(requirementTexts([spec], "FR-\\d{3}")).toEqual([
      { id: "FR-001", text: "**FR-001**: Hệ thống MUST xuất CSV." },
      { id: "FR-002", text: "FR-002 tổng hợp" },
    ]);
  });
});
