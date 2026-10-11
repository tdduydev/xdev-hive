import { describe, expect, it } from "vitest";
import { hubToWorker, PROTOCOL_VERSION, steerResultData, workerToHub } from "./worker-protocol.ts";

describe("worker protocol", () => {
  it("nhận gói hello hợp lệ và điền resumeRuns mặc định", () => {
    const msg = workerToHub.parse({
      type: "hello",
      v: PROTOCOL_VERSION,
      id: "m1",
      machineId: "build-01",
      version: "0.1.0",
      protoRange: [1, 1],
      os: "linux",
      clis: ["claude", "codex"],
      capacity: 2,
    });
    expect(msg.type === "hello" && msg.resumeRuns).toEqual([]);
  });

  it("từ chối machineId có chữ hoa", () => {
    const r = workerToHub.safeParse({
      type: "hello",
      v: 1,
      id: "m1",
      machineId: "Build",
      version: "0",
      protoRange: [1, 1],
      os: "linux",
      clis: [],
      capacity: 0,
    });
    expect(r.success).toBe(false);
  });

  it("từ chối upgrade_required thiếu sha256 đúng dạng", () => {
    const r = hubToWorker.safeParse({
      type: "upgrade_required",
      v: 1,
      id: "u",
      url: "https://hub/w",
      sha256: "abc",
      sig: "s",
    });
    expect(r.success).toBe(false);
  });
});

// Cùng file mẫu với test Go (worker/internal/channel/protocol_test.go): hai bên đọc chung để tên trường không lệch.
describe("file mẫu dùng chung với worker Go", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixtures = JSON.parse(await readFile(new URL("../fixtures/worker-protocol.json", import.meta.url), "utf8")) as {
    workerToHub: { type: string }[];
    hubToWorker: { type: string }[];
  };

  it.each(fixtures.workerToHub)("worker → hub: $type hợp lệ và không mất trường", (msg) => {
    expect(workerToHub.parse(msg)).toEqual(msg);
  });

  it.each(fixtures.hubToWorker)("hub → worker: $type hợp lệ và không mất trường", (msg) => {
    expect(hubToWorker.parse(msg)).toEqual(msg);
  });

  it("có mẫu cho mọi loại gói", () => {
    const types = (u: typeof workerToHub | typeof hubToWorker) => u.options.map((o) => o.shape.type.value).sort();
    expect(fixtures.workerToHub.map((m) => m.type).sort()).toEqual(types(workerToHub));
    expect(fixtures.hubToWorker.map((m) => m.type).sort()).toEqual(types(hubToWorker));
  });
});

describe("ràng buộc gói", () => {
  it("run_event dùng `event`, không nhận loại sự kiện lạ", () => {
    const base = { type: "run_event", v: 1, id: "e", runId: "r", attempt: 1, seq: 0, data: {} };
    expect(workerToHub.safeParse({ ...base, event: "phase" }).success).toBe(true);
    expect(workerToHub.safeParse({ ...base, event: "khac" }).success).toBe(false);
  });

  it("steer của hub cũ (không steerId, attempt) vẫn hợp lệ", () => {
    const msg = { type: "steer", v: 1, id: "s", runId: "r", input: "dùng pnpm" };
    expect(hubToWorker.parse(msg)).toEqual(msg);
  });

  it("steer_result báo đã hay chưa áp dụng chỉ dẫn", () => {
    const base = { type: "run_event", v: 1, id: "e", runId: "r", attempt: 1, seq: 3, event: "steer_result" };
    const data = { steerId: "42", applied: false, reason: "CLI codex chưa nhận chỉ dẫn giữa chừng" };
    expect(workerToHub.safeParse({ ...base, data }).success).toBe(true);
    expect(steerResultData.parse(data)).toEqual(data);
    expect(steerResultData.safeParse({ steerId: "42" }).success).toBe(false);
  });

  it("log_chunk đòi bytes là base64", () => {
    const base = { type: "log_chunk", v: 1, id: "l", runId: "r", attempt: 1, seq: 0, offset: 0 };
    expect(workerToHub.safeParse({ ...base, bytes: "aGk=" }).success).toBe(true);
    expect(workerToHub.safeParse({ ...base, bytes: "không phải base64" }).success).toBe(false);
  });

  it("từ chối attempt bằng 0", () => {
    expect(workerToHub.safeParse({ type: "job_accept", v: 1, id: "a", runId: "r", attempt: 0 }).success).toBe(false);
  });

  it("heartbeat thiếu runs thì mặc định rỗng", () => {
    const msg = workerToHub.parse({ type: "heartbeat", v: 1, id: "h", load: 0 });
    expect(msg.type === "heartbeat" && msg.runs).toEqual([]);
  });
});
