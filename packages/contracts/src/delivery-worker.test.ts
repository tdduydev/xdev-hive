import { describe, expect, it } from "vitest";
import { credentialRef, deliveryCapability, deliveryEvent, deliveryJobSpec } from "./delivery-worker.ts";

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
      { ...head, type: "health", ok: true, status: 200 },
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
