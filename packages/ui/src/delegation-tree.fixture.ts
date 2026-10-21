import type { DelegationTreeData, TreeRunData } from "./delegation-tree-model.ts";

/** Cây mẫu cho test: task đang chạy (run code, review con, hai sub-agent lồng), task xong, task có run lỗi. */
export const run = (over: Partial<TreeRunData> & { id: string }): TreeRunData => ({
  kind: "code",
  state: "succeeded",
  attempt: 1,
  parentRunId: null,
  machine: { id: "m1", name: "mac-ha" },
  cli: "claude",
  account: "Pro Hà",
  startedAt: "2026-10-21T01:00:00.000Z",
  endedAt: "2026-10-21T01:05:00.000Z",
  costUsd: 0.42,
  error: null,
  subagents: [],
  subagentsUnsupported: false,
  ...over,
});

export const TREE: DelegationTreeData = {
  thread: { id: "t1", title: "Phân quyền menu", createdAt: "2026-10-21T00:00:00.000Z" },
  hidden: 0,
  active: true,
  tasks: [
    {
      id: "k1",
      key: "PAY-1",
      title: "Bảng quyền",
      status: "running",
      projectKey: "PAY",
      createdBy: "leader",
      runs: [
        run({
          id: "r1",
          state: "running",
          endedAt: null,
          subagents: [
            {
              id: "s1",
              parentId: null,
              type: "Explore",
              description: "Tìm code",
              status: "completed",
              depth: 1,
              tokens: 1200,
              toolUses: 3,
              durationMs: 4000,
            },
            {
              id: "s2",
              parentId: "s1",
              type: "test-runner",
              description: "Chạy test",
              status: "running",
              depth: 2,
              tokens: null,
              toolUses: null,
              durationMs: null,
            },
          ],
        }),
        run({ id: "r2", kind: "review", parentRunId: "r1" }),
      ],
    },
    {
      id: "k2",
      key: "PAY-2",
      title: "Menu theo vai trò",
      status: "done",
      projectKey: "PAY",
      createdBy: "user",
      runs: [run({ id: "r3" })],
    },
    {
      id: "k3",
      key: "PAY-3",
      title: "Sửa lỗi",
      status: "review",
      projectKey: "PAY",
      createdBy: "leader",
      runs: [run({ id: "r4", state: "failed", error: "Test hỏng" })],
    },
  ],
};
