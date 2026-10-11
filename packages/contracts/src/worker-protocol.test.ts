import { describe, expect, it } from "vitest";
import { hubToWorker, PROTOCOL_VERSION, workerToHub } from "./worker-protocol.ts";

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
    expect(msg.resumeRuns).toEqual([]);
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
