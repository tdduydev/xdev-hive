import { describe, expect, it, vi } from "vitest";
import { HubStatus, taskCode } from "@/codelens/hub-status.ts";
import { createHubClient } from "@/hub/client.ts";
import { createFakeHub } from "../../test/fake-hub.ts";

const orgId = "12345678-1234-1234-1234-123456789abc";
const token = `hive_pat_${orgId}_${"a".repeat(43)}`;
const projectId = "11111111-1111-4111-8111-111111111111";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-10-15T00:00:00.000Z";

const task = (n: number, status: string, source: Record<string, unknown>, title = "x") => ({
  id: id(n),
  projectId,
  teamId: id(900),
  key: `P-${n}`,
  number: n,
  title,
  body: "",
  type: null,
  status,
  preferredCli: null,
  source,
  createdBy: "u",
  createdAt: now,
  updatedAt: now,
});
const run = (n: number, taskId: string, state: string) => ({
  id: id(n),
  taskId,
  projectId,
  teamId: id(900),
  kind: "code",
  parentRunId: null,
  state,
  attempt: 1,
  maxAttempts: 3,
  machineId: null,
  machineName: null,
  cli: null,
  model: null,
  pinnedMachineId: null,
  branch: "ai/P-1",
  policySnapshot: [],
  result: null,
  headSha: null,
  prUrl: null,
  timeoutSec: 60,
  cost: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: null, accountId: null },
  explore: null,
  rtk: null,
  createdBy: "u",
  ownerUserId: null,
  createdAt: now,
  startedAt: null,
  finishedAt: null,
  updatedAt: now,
});

function setup(options: { signedIn: boolean; tasks?: unknown[]; runs?: unknown[] }) {
  const fake = createFakeHub({
    rpc: {
      tasks: { list: () => (options.tasks ?? []) as never },
      runs: { latest: () => (options.runs ?? []) as never },
    },
  });
  const hub = createHubClient({
    hubUrl: () => "http://hub.test",
    auth: { token: async () => (options.signedIn ? token : undefined), invalidate: vi.fn() },
    fetch: fake.fetch,
  });
  const status = new HubStatus({
    signedIn: async () => options.signedIn,
    project: async () => projectId,
    tasks: (projectId, signal) => hub.rpc.tasks.list({ projectId }, { signal }),
    runs: (projectId, signal) => hub.rpc.runs.latest({ projectId }, { signal }),
  });
  return { fake, status };
}

describe("HubStatus", () => {
  it("chưa đăng nhập thì không có request nào tới hub", async () => {
    const { fake, status } = setup({ signedIn: false });
    status.watchRoot("/r", "017");
    await status.refresh(new AbortController().signal);
    expect(fake.requests).toHaveLength(0);
    expect(status.isSignedOut).toBe(true);
  });

  it("task đang chạy cùng mã spec và task có run đang hoạt động", async () => {
    const { status } = setup({
      signedIn: true,
      tasks: [
        task(1, "running", { spec: "017", task: "T023" }),
        task(2, "queued", {}, "017/T024 — làm tiếp"),
        task(3, "running", { spec: "018", task: "T023" }),
        task(4, "done", { spec: "017", task: "T001" }),
        task(5, "review", { spec: "017", task: "T002" }),
      ],
      runs: [
        run(11, id(1), "running"),
        run(12, id(2), "queued"),
        run(13, id(3), "running"),
        run(14, id(4), "succeeded"),
      ],
    });
    status.watchRoot("/r", "017");
    await status.refresh(new AbortController().signal);
    expect(status.isSignedOut).toBe(false);
    expect(status.lookup("/r", "017", "T023")).toEqual({ runId: id(11), kind: "running" });
    expect(status.lookup("/r", "017", "T024")).toEqual({ runId: id(12), kind: "queued" });
    expect(status.lookup("/r", "017", "T001")).toBeUndefined();
    expect(status.lookup("/r", "017", "T002")).toBeUndefined();
    expect(status.lookup("/r", "018", "T023")).toBeUndefined();
  });

  it("run đã kết thúc thì không hiện là đang chạy", async () => {
    const { status } = setup({
      signedIn: true,
      tasks: [task(1, "running", { spec: "017", task: "T023" })],
      runs: [run(11, id(1), "failed")],
    });
    status.watchRoot("/r", "017");
    await status.refresh(new AbortController().signal);
    expect(status.lookup("/r", "017", "T023")).toBeUndefined();
  });

  it("đăng xuất xoá trạng thái đã có và báo thay đổi", async () => {
    let signedIn = true;
    const status = new HubStatus({
      signedIn: async () => signedIn,
      project: async () => projectId,
      tasks: async () => [task(1, "running", { spec: "017", task: "T023" })],
      runs: async () => [run(11, id(1), "running")],
    });
    const changed = vi.fn();
    status.onDidChange(changed);
    status.watchRoot("/r", "017");
    await status.refresh(new AbortController().signal);
    signedIn = false;
    await status.refresh(new AbortController().signal);
    expect(status.lookup("/r", "017", "T023")).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("taskCode nhận source hoặc tiền tố tiêu đề", () => {
    expect(taskCode(task(1, "running", { spec: "017", task: "T023" }), "017")).toBe("T023");
    expect(taskCode(task(1, "running", { spec: "017", task: "x" }, "017/T9 nope"), "017")).toBeUndefined();
    expect(taskCode(task(1, "running", {}, "017/T023a — x"), "017")).toBe("T023a");
    expect(taskCode(task(1, "running", {}, "T023 không có spec"), "017")).toBeUndefined();
  });
});
