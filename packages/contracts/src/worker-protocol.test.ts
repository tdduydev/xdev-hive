import { describe, expect, it } from "vitest";
import {
  costEventData,
  hubToWorker,
  PROTOCOL_VERSION,
  SDLC_ARTIFACT_LIMITS,
  sdlcJobSpec,
  sdlcReportArtifacts,
  steerResultData,
  workerToHub,
} from "./worker-protocol.ts";

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

  it("nhận thông tin runner host và capacity phần cứng", () => {
    const msg = workerToHub.parse({
      type: "hello",
      v: PROTOCOL_VERSION,
      id: "m1",
      machineId: "host-01",
      version: "0.1.0",
      protoRange: [1, 1],
      os: "linux",
      runnerMode: "host",
      cpuCount: 16,
      memoryMB: 65536,
      clis: ["codex"],
      capacity: 4,
    });
    expect(msg.type === "hello" && msg.runnerMode).toBe("host");
    expect(msg.type === "hello" && msg.memoryMB).toBe(65536);
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

  // Gói hub chỉ gửi cho worker đã khai capability tương ứng, nên worker Go chưa biết gói vẫn chạy đúng. Mẫu của gói
  // nằm trong file chung khi worker Go có kiểu cho nó (account_set: specs/011 T061 thêm mẫu và bỏ khỏi danh sách này).
  const notInGoYet = new Set(["account_set"]);

  it("có mẫu cho mọi loại gói", () => {
    const types = (u: typeof workerToHub | typeof hubToWorker) =>
      u.options
        .map((o) => o.shape.type.value)
        .filter((t) => !notInGoYet.has(t))
        .sort();
    expect(fixtures.workerToHub.map((m) => m.type).sort()).toEqual(types(workerToHub));
    expect(fixtures.hubToWorker.map((m) => m.type).sort()).toEqual(types(hubToWorker));
  });
});

describe("ràng buộc gói", () => {
  it("run_result nhận worker cũ; số liệu diff phải đầy đủ và không âm", () => {
    const base = {
      type: "run_result",
      v: 1,
      id: "r",
      runId: "run",
      attempt: 1,
      seq: 0,
      exit: 0,
      headSha: null,
      report: null,
    };
    expect(workerToHub.safeParse(base).success).toBe(true);
    expect(
      workerToHub.safeParse({ ...base, diffStats: { addedLines: -1, deletedLines: 0, changedFiles: [] } }).success,
    ).toBe(false);
    expect(workerToHub.safeParse({ ...base, diffStats: { addedLines: 12 } }).success).toBe(false);
  });

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

describe("AI SDLC (specs/011)", () => {
  const account = {
    id: "claude-work-2",
    cli: "claude",
    label: "work-2",
    roles: ["code", "plan"],
    enabled: true,
    loggedIn: true,
    sessionPct: 42.5,
    weekPct: 10,
    resetsAt: "2026-10-13T15:30:00.000Z",
    stopAtSession: 90,
    stopAtWeek: 95,
    inUse: 1,
  };

  it("heartbeat của worker cũ (không accounts) vẫn parse, accounts để trống", () => {
    const msg = workerToHub.parse({ type: "heartbeat", v: 1, id: "h", load: 1, runs: [] });
    expect(msg.type === "heartbeat" && msg.accounts).toBeUndefined();
  });

  it("heartbeat mang tóm tắt tài khoản, không nhận email hay token", () => {
    const msg = { type: "heartbeat", v: 1, id: "h", load: 0, runs: [], accounts: [account] };
    expect(workerToHub.parse(msg)).toEqual(msg);
    // Trường lạ bị bỏ chứ không đi tiếp vào hub.
    const leaked = workerToHub.parse({ ...msg, accounts: [{ ...account, email: "a@b.vn", token: "sk-1" }] });
    expect(leaked.type === "heartbeat" && leaked.accounts?.[0]).toEqual(account);
    expect(workerToHub.safeParse({ ...msg, accounts: [{ ...account, sessionPct: 120 }] }).success).toBe(false);
    expect(workerToHub.safeParse({ ...msg, accounts: Array(33).fill(account) }).success).toBe(false);
  });

  it("account_set và welcome.features", () => {
    const set = { type: "account_set", v: 1, id: "a", accountId: "claude-work-2", enabled: false };
    expect(hubToWorker.parse(set)).toEqual(set);
    expect(hubToWorker.safeParse({ ...set, enabled: "no" }).success).toBe(false);
    const welcome = { type: "welcome", v: 1, id: "w", sessionId: "s", heartbeatSec: 30 };
    expect(hubToWorker.parse(welcome)).toEqual(welcome);
    expect(hubToWorker.parse({ ...welcome, features: ["shared"] })).toEqual({ ...welcome, features: ["shared"] });
  });

  it("spec.sdlc đi qua catchall của job_offer và chỉ nhận đường dẫn trong repo", () => {
    const sdlc = {
      step: "draft",
      seed: [{ path: "specs/012-hoan-tien/spec.md", content: "# Spec" }],
      collect: [{ artifactId: "spec", path: "specs/012-hoan-tien/spec.md" }],
    };
    const offer = { type: "job_offer", v: 1, id: "o", runId: "r", attempt: 1, spec: { sdlc }, ttl: 30 };
    expect(hubToWorker.parse(offer)).toEqual(offer);
    expect(sdlcJobSpec.parse(sdlc)).toEqual(sdlc);
    for (const path of ["../x.md", "/etc/passwd", "a/../../b", "a\\b"])
      expect(sdlcJobSpec.safeParse({ ...sdlc, collect: [{ artifactId: "spec", path }] }).success).toBe(false);
  });

  it("report.artifacts có sha256 và giới hạn số file", () => {
    const file = { artifactId: "spec", path: "specs/012-x/spec.md", content: "# Spec", sha256: "a".repeat(64) };
    expect(sdlcReportArtifacts.parse([file])).toEqual([file]);
    expect(sdlcReportArtifacts.safeParse([{ ...file, sha256: "abc" }]).success).toBe(false);
    expect(sdlcReportArtifacts.safeParse(Array(SDLC_ARTIFACT_LIMITS.files + 1).fill(file)).success).toBe(false);
    const big = { ...file, content: "x".repeat(SDLC_ARTIFACT_LIMITS.fileChars + 1) };
    expect(sdlcReportArtifacts.safeParse([big]).success).toBe(false);
  });
});

describe("sự kiện cost", () => {
  const base = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    costUsd: null,
    turns: null,
    model: null,
  };

  it("accountId là tuỳ chọn: worker cũ và đăng nhập mặc định không báo", () => {
    expect(costEventData.parse(base).accountId).toBeUndefined();
    expect(costEventData.parse({ ...base, accountId: null }).accountId).toBeNull();
    expect(costEventData.parse({ ...base, accountId: "claude-2" }).accountId).toBe("claude-2");
  });

  it("từ chối accountId rỗng", () => {
    expect(costEventData.safeParse({ ...base, accountId: "" }).success).toBe(false);
  });

  it("rtk là tuỳ chọn và chỉ nhận số nguyên không âm", () => {
    expect(costEventData.parse(base).rtk).toBeUndefined();
    expect(costEventData.parse({ ...base, rtk: { commands: 12, savedTokens: 3400 } }).rtk).toEqual({
      commands: 12,
      savedTokens: 3400,
    });
    for (const bad of [{ commands: -1, savedTokens: 0 }, { commands: 1, savedTokens: 1.5 }, { commands: 1 }]) {
      expect(costEventData.safeParse({ ...base, rtk: bad }).success).toBe(false);
    }
  });

  it("guard là tuỳ chọn và chỉ nhận số nguyên không âm", () => {
    expect(costEventData.parse(base).guard).toBeUndefined();
    const guard = { contextPackFiles: 14, exploreBlocked: 2, truncatedChars: 30_000 };
    expect(costEventData.parse({ ...base, guard }).guard).toEqual(guard);
    for (const bad of [{ ...guard, exploreBlocked: -1 }, { ...guard, truncatedChars: 1.5 }, { contextPackFiles: 1 }]) {
      expect(costEventData.safeParse({ ...base, guard: bad }).success).toBe(false);
    }
  });
});
