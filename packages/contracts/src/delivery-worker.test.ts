import { describe, expect, it } from "vitest";
import {
  credentialRef,
  DELIVERY_JOB_KINDS,
  DELIVERY_METHODS,
  deliveryCapability,
  deliveryEvent,
  deliveryJobEvent,
  deliveryJobSpec,
  deliveryMethod,
  testReportParams,
} from "./delivery-worker.ts";

const jobId = "6f1c2a40-8f3b-4c1e-9d55-0a1b2c3d4e5f";
const at = "2026-10-23T08:00:00.000Z";

describe("credentialRef", () => {
  it("nhận tên hợp lệ", () => {
    expect(credentialRef.safeParse("jenkins-prod").success).toBe(true);
  });
  it.each(["", "Jenkins", "a b", "a_b", "x".repeat(65)])("từ chối %j", (name) => {
    expect(credentialRef.safeParse(name).success).toBe(false);
  });
});

describe("deliveryCapability", () => {
  it("mặc định rỗng và bỏ qua trường lạ", () => {
    expect(deliveryCapability.parse({ future: 1 })).toEqual({ methods: [], credentials: [], kinds: [] });
  });
  it("nhận `test-report` ở `kinds`, không nhận ở `methods`", () => {
    expect(deliveryCapability.parse({ kinds: ["test-report"] }).kinds).toEqual(["test-report"]);
    expect(deliveryCapability.safeParse({ methods: ["test-report"] }).success).toBe(false);
    expect(deliveryCapability.safeParse({ kinds: ["argocd"] }).success).toBe(false);
  });
  it("từ chối cách chạy lạ", () => {
    expect(deliveryCapability.safeParse({ methods: ["scp"] }).success).toBe(false);
  });
});

describe("deliveryJobSpec", () => {
  const base = { jobId, kind: "jenkins-job", configVersion: 3, target: { job: "deploy/web" } };
  it("điền mặc định", () => {
    const parsed = deliveryJobSpec.parse(base);
    expect(parsed.credential).toBeNull();
    expect(parsed.deployId).toBeNull();
    expect(parsed.timeoutSeconds).toBe(1800);
  });
  it("từ chối tên credential sai", () => {
    expect(deliveryJobSpec.safeParse({ ...base, credential: "Token Thật" }).success).toBe(false);
  });
  it("từ chối loại việc lạ", () => {
    expect(deliveryJobSpec.safeParse({ ...base, kind: "rsync" }).success).toBe(false);
  });
});

describe("việc test-report (specs/036)", () => {
  const read = {
    op: "read",
    projectPath: "group/e2e-tests",
    pipelineId: 18342,
    mode: "playwright-artifact",
    jobFilter: ["e2e:*"],
    artifactPath: "playwright-report/results.json",
  };
  const spec = {
    jobId,
    kind: "test-report",
    configVersion: 0,
    target: { baseUrl: "https://gitlab.example.com" },
    credential: "gitlab-main",
    params: read,
    timeoutSeconds: 600,
  };

  it("là loại việc nhưng không phải cách triển khai", () => {
    expect(DELIVERY_JOB_KINDS).toContain("test-report");
    expect(DELIVERY_METHODS).not.toContain("test-report");
    expect(deliveryMethod.safeParse("test-report").success).toBe(false);
  });

  it("nhận việc read và list hợp lệ", () => {
    expect(deliveryJobSpec.parse(spec).params).toEqual(read);
    const list = { op: "list", projectPath: "a/b/c", ref: "main", updatedAfter: at, limit: 500 };
    expect(deliveryJobSpec.safeParse({ ...spec, params: list, timeoutSeconds: 120 }).success).toBe(true);
    expect(testReportParams.parse({ op: "read", projectPath: "a/b", pipelineId: 1, mode: "pipeline-report" })).toEqual({
      op: "read",
      projectPath: "a/b",
      pipelineId: 1,
      mode: "pipeline-report",
      jobFilter: [],
    });
  });

  it.each([
    ["thiếu op", { ...read, op: undefined }],
    ["op lạ", { ...read, op: "write" }],
    ["project một cấp", { ...read, projectPath: "e2e-tests" }],
    ["project có dấu cách", { ...read, projectPath: "group/e2e tests" }],
    ["project có ..", { ...read, projectPath: "../e2e-tests" }],
    ["project có . giữa", { ...read, projectPath: "group/./e2e-tests" }],
    ["project quá dài", { ...read, projectPath: `g/${"a".repeat(254)}` }],
    ["pipeline 0", { ...read, pipelineId: 0 }],
    ["mode lạ", { ...read, mode: "allure" }],
    ["quá 20 bộ lọc job", { ...read, jobFilter: Array.from({ length: 21 }, (_, i) => `j${i}`) }],
    ["bộ lọc job quá dài", { ...read, jobFilter: ["x".repeat(101)] }],
    ["artifact tuyệt đối", { ...read, artifactPath: "/etc/passwd" }],
    ["artifact có ..", { ...read, artifactPath: "report/../../x.json" }],
    ["artifact có .. kiểu Windows", { ...read, artifactPath: "report\\..\\x.json" }],
    ["artifact quá dài", { ...read, artifactPath: "a".repeat(256) }],
    ["mode artifact thiếu artifactPath", { ...read, artifactPath: undefined }],
    ["trường lạ", { ...read, token: "glpat-xxx" }],
    ["list limit 0", { op: "list", projectPath: "a/b", limit: 0 }],
    ["list limit 501", { op: "list", projectPath: "a/b", limit: 501 }],
    ["list ngày sai", { op: "list", projectPath: "a/b", limit: 5, updatedAfter: "hôm qua" }],
  ])("từ chối params: %s", (_, params) => {
    expect(deliveryJobSpec.safeParse({ ...spec, params }).success).toBe(false);
  });

  it("không gắn lần triển khai", () => {
    expect(deliveryJobSpec.safeParse({ ...spec, deployId: jobId }).success).toBe(false);
  });

  it("params của Jenkins và Argo CD vẫn tự do", () => {
    const jenkins = { jobId, kind: "jenkins-job", configVersion: 1, target: {}, params: { op: "write", any: 1 } };
    expect(deliveryJobSpec.safeParse(jenkins).success).toBe(true);
  });
});

describe("deliveryEvent", () => {
  const head = { jobId, seq: 1, at };
  it("nhận từng loại sự kiện", () => {
    for (const e of [
      { ...head, type: "started", workerId: "w1" },
      { ...head, type: "step", name: "build", state: "running" },
      { ...head, type: "external", ref: "deploy/web#12", url: "https://jenkins.example/job/web/12" },
      { ...head, type: "finished", state: "failed", error: { code: "timeout", message: "Hết thời gian" } },
    ]) {
      expect(deliveryEvent.safeParse(e).success).toBe(true);
    }
  });
  it("không có kiểu sự kiện mang thân log (FR-050)", () => {
    expect(deliveryEvent.safeParse({ ...head, type: "log", text: "Bước 1" }).success).toBe(false);
  });
  it("cắt thông điệp lỗi ở 200 ký tự", () => {
    const e = { ...head, type: "finished", state: "failed", error: { code: "x", message: "a".repeat(201) } };
    expect(deliveryEvent.safeParse(e).success).toBe(false);
  });
});

describe("sự kiện test-results và pipelines (specs/036)", () => {
  const head = { jobId, seq: 3, at };
  const pipeline = {
    ref: "main",
    sha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
    status: "failed",
    source: "push",
    startedAt: "2026-10-23T07:52:00Z",
    finishedAt: "2026-10-23T08:05:00Z",
  };
  const results = {
    ...head,
    type: "test-results",
    pipeline,
    jobIds: [99120, 99121],
    totals: { total: 214, passed: 205, failed: 4, skipped: 3, flaky: 2 },
    unmapped: 11,
    ambiguous: 1,
    unknownCodes: ["TC-KHAM-0999"],
    truncated: false,
    cases: [
      { code: "TC-KHAM-001", status: "passed", retries: 0, durationMs: 4210, worstJobId: 99120 },
      { code: "TC-KHAM-002", status: "flaky", retries: 1, durationMs: 9800 },
    ],
  };
  const pipelines = { ...head, type: "pipelines", items: [{ pipelineId: 18342, ...pipeline, startedAt: null }] };
  const tc = (i: number) => ({
    code: `TC-KHAM-${String(i).padStart(4, "0")}`,
    status: "passed",
    retries: 0,
    durationMs: 1,
  });

  it("nhận sự kiện đúng mẫu của contract", () => {
    expect(deliveryJobEvent.parse(results)).toEqual(results);
    expect(deliveryJobEvent.parse(pipelines)).toEqual(pipelines);
  });

  it("phần triển khai không nhận sự kiện kết quả test", () => {
    expect(deliveryEvent.safeParse(results).success).toBe(false);
    expect(deliveryJobEvent.safeParse({ ...head, type: "started", workerId: "w1" }).success).toBe(true);
  });

  // SC-003: tên test, tên suite, thông báo lỗi không được rời máy; trường lạ ở mọi cấp đều bị từ chối.
  it.each([
    ["name ở gốc", { ...results, name: "login works" }],
    ["message ở gốc", { ...results, message: "expected 200" }],
    ["name ở case", { ...results, cases: [{ ...results.cases[0], name: "TC-KHAM-001 đăng nhập" }] }],
    ["message ở case", { ...results, cases: [{ ...results.cases[0], message: "AssertionError" }] }],
    ["suite ở case", { ...results, cases: [{ ...results.cases[0], suite: "login" }] }],
    ["stack ở totals", { ...results, totals: { ...results.totals, stack: "at x" } }],
    ["name ở pipeline", { ...results, pipeline: { ...pipeline, name: "nightly" } }],
  ])("từ chối test-results có %s", (_, e) => {
    expect(deliveryJobEvent.safeParse(e).success).toBe(false);
  });

  it.each([
    ["mã TC kiểu 035", { ...results, cases: [{ ...results.cases[0], code: "TC-001" }] }],
    ["trạng thái lạ", { ...results, cases: [{ ...results.cases[0], status: "error" }] }],
    ["retries 21", { ...results, cases: [{ ...results.cases[0], retries: 21 }] }],
    ["thời gian âm", { ...results, cases: [{ ...results.cases[0], durationMs: -1 }] }],
    ["sha ngắn", { ...results, pipeline: { ...pipeline, sha: "9fceb02" } }],
    ["pipeline còn chạy", { ...results, pipeline: { ...pipeline, status: "running" } }],
    ["source tự do", { ...results, pipeline: { ...pipeline, source: "TC-KHAM-001 login" } }],
    ["quá 100 job", { ...results, jobIds: Array.from({ length: 101 }, (_, i) => i + 1) }],
    ["quá 200 mã lạ", { ...results, unknownCodes: Array.from({ length: 201 }, (_, i) => tc(i).code) }],
    ["quá 5000 case", { ...results, cases: Array.from({ length: 5001 }, (_, i) => tc(i)) }],
    ["số đếm âm", { ...results, unmapped: -1 }],
  ])("từ chối test-results có %s", (_, e) => {
    expect(deliveryJobEvent.safeParse(e).success).toBe(false);
  });

  it("nhận đúng 5000 case", () => {
    const e = { ...results, cases: Array.from({ length: 5000 }, (_, i) => tc(i)), truncated: true };
    expect(deliveryJobEvent.safeParse(e).success).toBe(true);
  });

  it.each([
    ["quá 100 pipeline", { ...pipelines, items: Array.from({ length: 101 }, () => pipelines.items[0]) }],
    ["trường lạ ở pipeline", { ...pipelines, items: [{ ...pipelines.items[0], name: "nightly" }] }],
    ["pipelineId 0", { ...pipelines, items: [{ ...pipelines.items[0], pipelineId: 0 }] }],
  ])("từ chối pipelines có %s", (_, e) => {
    expect(deliveryJobEvent.safeParse(e).success).toBe(false);
  });
});

// Cùng file mẫu với test Go (worker/internal/delivery/contract_test.go): worker chạy thật từng việc rồi so sự kiện phát ra
// với `runs`, nên tên trường, giá trị mặc định và dạng thời gian không lệch giữa hai bên.
describe("file mẫu dùng chung với worker Go", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixtures = JSON.parse(await readFile(new URL("../fixtures/delivery-worker.json", import.meta.url), "utf8")) as {
    jobSpecs: { jobId: string; kind: string }[];
    runs: { jobId: string; events: { type: string }[] }[];
    events: { type: string }[];
  };
  const allEvents = [...fixtures.runs.flatMap((r) => r.events), ...fixtures.events];

  it.each(fixtures.jobSpecs)("việc $kind ($jobId) hợp lệ và ghi đủ mọi trường", (spec) => {
    expect(deliveryJobSpec.parse(spec)).toEqual(spec);
  });

  it.each(allEvents)("sự kiện $type hợp lệ và không mất trường", (event) => {
    expect(deliveryJobEvent.parse(event)).toEqual(event);
  });

  it("mỗi lần chạy khớp một việc, seq tăng từ 0 và kết thúc bằng đúng một finished", () => {
    for (const run of fixtures.runs) {
      expect(fixtures.jobSpecs.some((s) => s.jobId === run.jobId)).toBe(true);
      const events = run.events.map((e) => deliveryJobEvent.parse(e));
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
      expect(events.every((e) => e.jobId === run.jobId)).toBe(true);
      expect(events.filter((e) => e.type === "finished")).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("finished");
    }
  });

  it("có mẫu cho mọi loại việc và mọi loại sự kiện", () => {
    expect([...new Set(fixtures.jobSpecs.map((s) => s.kind))].sort()).toEqual([...DELIVERY_JOB_KINDS].sort());
    const types = deliveryJobEvent.options.map((o) => o.shape.type.value).sort();
    expect([...new Set(allEvents.map((e) => e.type))].sort()).toEqual(types);
  });
});
