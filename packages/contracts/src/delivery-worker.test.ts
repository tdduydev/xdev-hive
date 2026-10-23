import { describe, expect, it } from "vitest";
import {
  credentialRef,
  DELIVERY_JOB_KINDS,
  deliveryCapability,
  deliveryEvent,
  deliveryJobSpec,
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
    expect(deliveryCapability.parse({ future: 1 })).toEqual({ methods: [], credentials: [] });
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
    expect(deliveryEvent.parse(event)).toEqual(event);
  });

  it("mỗi lần chạy khớp một việc, seq tăng từ 0 và kết thúc bằng đúng một finished", () => {
    for (const run of fixtures.runs) {
      expect(fixtures.jobSpecs.some((s) => s.jobId === run.jobId)).toBe(true);
      const events = run.events.map((e) => deliveryEvent.parse(e));
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
      expect(events.every((e) => e.jobId === run.jobId)).toBe(true);
      expect(events.filter((e) => e.type === "finished")).toHaveLength(1);
      expect(events.at(-1)?.type).toBe("finished");
    }
  });

  it("có mẫu cho mọi loại việc và mọi loại sự kiện", () => {
    expect([...new Set(fixtures.jobSpecs.map((s) => s.kind))].sort()).toEqual([...DELIVERY_JOB_KINDS].sort());
    const types = deliveryEvent.options.map((o) => o.shape.type.value).sort();
    expect([...new Set(allEvents.map((e) => e.type))].sort()).toEqual(types);
  });
});
