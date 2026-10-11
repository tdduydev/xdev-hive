import type { Run, Task } from "@xdev-hive/contracts";

/** Task và run mẫu cho test của lib/; chỉ ghi đè trường test cần. */
export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    teamId: "team1",
    key: "HD-1",
    number: 1,
    title: "Sửa làm tròn VAT",
    body: "",
    type: null,
    status: "todo",
    preferredCli: null,
    source: { kind: "web" },
    createdBy: "u1",
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
    ...over,
  };
}

export function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: "7f3a21c0-0000-4000-8000-000000000001",
    taskId: "t1",
    projectId: "p1",
    teamId: "team1",
    kind: "code",
    parentRunId: null,
    state: "queued",
    attempt: 1,
    maxAttempts: 3,
    machineId: null,
    machineName: null,
    cli: "claude",
    model: null,
    pinnedMachineId: null,
    branch: "ai/HD-1",
    policySnapshot: [],
    result: null,
    headSha: null,
    prUrl: null,
    timeoutSec: 3600,
    cost: { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: null },
    createdBy: "u1",
    createdAt: "2026-10-11T11:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-10-11T11:00:00.000Z",
    ...over,
  };
}
