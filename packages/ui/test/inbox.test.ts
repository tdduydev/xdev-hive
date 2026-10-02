import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { may, type Actor, type AgentRun, type ChatAction, type Memory, type Proposal, type SdlcGateRecord, type Task } from "@xdev-hive/core";
import { buildInbox, inboxProject, shortAgo } from "#ui/lib/inbox.ts";

const run = (over: Partial<AgentRun>): AgentRun => ({ id: "R-1", project: "demo", taskId: "T-1", createdAt: "2026-09-30T10:00:00Z", mrUrl: null, pipelineStatus: null, ...over }) as AgentRun;
const memory = (over: Partial<Memory>): Memory => ({ id: 1, project: "demo", kind: "decision", content: "x", author: "a", status: "approved", createdAt: "2026-09-30T09:00:00Z", conflictsWith: [], ...over }) as Memory;

describe("inbox", () => {
  it("lists a failed pipeline once per merge request, from its newest run", () => {
    const items = buildInbox({
      runs: [
        run({ id: "R-1", mrUrl: "https://git/mr/1", pipelineStatus: "failed", createdAt: "2026-09-30T10:00:00Z" }),
        run({ id: "R-2", mrUrl: "https://git/mr/1", pipelineStatus: "failed", createdAt: "2026-09-30T10:05:00Z" }),
        run({ id: "R-3", mrUrl: "https://git/mr/2", pipelineStatus: "success" }),
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0]!.kind, "ci");
    assert.equal(items[0]!.kind === "ci" && items[0]!.run.id, "R-2");
  });

  it("pairs contradicting memory once, newest entry first, and leaves them out of the pending list", () => {
    const items = buildInbox({
      memory: [
        memory({ id: 212, status: "pending", createdAt: "2026-09-30T08:00:00Z", conflictsWith: [198] }),
        memory({ id: 198, createdAt: "2026-09-20T08:00:00Z", conflictsWith: [212] }),
        memory({ id: 214, status: "pending", project: null, createdAt: "2026-09-30T09:40:00Z" }),
      ],
    });
    assert.deepEqual(
      items.map((i) => i.key),
      ["memory:214", "conflict:198-212"],
    );
    const c = items[1]!;
    assert.ok(c.kind === "conflict" && c.memory.id === 212 && c.other.id === 198);
    assert.equal(inboxProject(items[0]!), null, "shared memory has no project");
  });

  it("keys a task in review by its last update, so a new handoff shows again", () => {
    const task = { id: "T-131", project: "notify", title: "Slack", status: "review", updatedAt: "2026-09-30T09:00:00Z" } as Task;
    const [a] = buildInbox({ reviewTasks: [task] });
    const [b] = buildInbox({ reviewTasks: [{ ...task, updatedAt: "2026-09-30T11:00:00Z" }] });
    assert.notEqual(a!.key, b!.key);
    const p = { id: 7, docKey: "project/pg/errors", status: "pending", createdAt: "2026-09-30T10:00:00Z" } as Proposal;
    assert.equal(inboxProject(buildInbox({ proposals: [p] })[0]!), "pg");
  });

  it("shows a merged task the MR watcher could not move to Done again, with its MR and the watcher's note", () => {
    // The watcher of a machine without Code review leaves the task in Review and adds a line to its note (QA-5).
    const handed = { id: "T-1", project: "demo", title: "x", status: "review", note: "Xong phần A", updatedAt: "2026-09-30T09:00:00Z" } as Task;
    const waiting = { ...handed, note: "Xong phần A\n\nMR !1 merged.\n\nMR đã merge, chờ người có quyền Review code chuyển Xong.", updatedAt: "2026-09-30T10:00:00Z" };
    const mr = run({ mrUrl: "https://git/mr/1", mrStatus: "merged", createdAt: "2026-09-30T08:00:00Z" });
    const [before] = buildInbox({ reviewTasks: [handed], runs: [mr] });
    const [after] = buildInbox({ reviewTasks: [waiting], runs: [mr] });
    assert.ok(after!.kind === "review" && after!.task.note === waiting.note && after!.run?.mrStatus === "merged");
    assert.notEqual(after!.key, before!.key, "seen or handled before the merge, it is new again");
    assert.equal(inboxProject(after!), "demo");
  });

  it("puts machine setup gaps last, with no time", () => {
    const items = buildInbox({
      setup: [
        { id: "shim", label: "hive-mcp", state: "outdated", detail: "", action: "Cập nhật" },
        // Optional: Spec Kit's CLI missing is no gap of the day (roadmap 20a).
        { id: "cli:specify", label: "Spec Kit CLI", state: "missing", detail: "", action: "Cài bằng uv" },
      ],
      proposals: [{ id: 1, docKey: "org/a", status: "pending", createdAt: "2026-09-30T10:00:00Z" } as Proposal],
    });
    assert.deepEqual(
      items.map((i) => i.kind),
      ["proposal", "machine"],
    );
    const t = (k: string, v?: { n: number }) => `${k}:${v?.n ?? ""}`;
    assert.equal(shortAgo("", Date.now(), t), "");
    const now = Date.parse("2026-09-30T12:00:00Z");
    assert.equal(shortAgo("2026-09-30T11:52:00Z", now, t), "inbox.ago.m:8");
    assert.equal(shortAgo("2026-09-30T10:00:00Z", now, t), "inbox.ago.h:2");
    assert.equal(shortAgo("2026-09-27T10:00:00Z", now, t), "inbox.ago.d:3");
  });

  it("lists gates waiting for a person and leaders' proposals nobody decided (roadmap 35c)", () => {
    const gate = (over: Partial<SdlcGateRecord>): SdlcGateRecord =>
      ({ id: 1, project: "pay", taskId: "S001", gate: "spec", mode: "human", status: "waiting", decidedBy: null, note: null, createdAt: "2026-10-02T09:00:00Z", decidedAt: null, ...over }) as SdlcGateRecord;
    const action = (over: Partial<ChatAction>): ChatAction => ({ id: 5, threadId: 2, project: "pay", kind: "run.dispatch", input: {}, reason: "x", status: "proposed", createdAt: "2026-10-02T08:00:00Z", ...over }) as ChatAction;
    const items = buildInbox({
      gates: [gate({ id: 1 }), gate({ id: 2, status: "escalated", gate: "review", taskId: "S001-T3", createdAt: "2026-10-02T10:00:00Z" }), gate({ id: 3, status: "passed" }), gate({ id: 4, status: "checking" })],
      leader: [action({ id: 5 }), action({ id: 6, status: "done" })],
    });
    assert.deepEqual(
      items.map((i) => [i.key, i.tone]),
      [
        ["gate:2", "danger"],
        ["gate:1", "warning"],
        ["leader:5", "info"],
      ],
    );
    assert.deepEqual(items.map(inboxProject), ["pay", "pay", "pay"]);
  });

  it("leaves out what the person could only look at", () => {
    // Hoa reviews docs and code on pay; on app she only reads.
    const hoa: Actor = { name: "hoa", role: "member", access: { projects: { pay: "reviewer", app: "viewer" } } };
    const can = (owner: string | null, p: Parameters<typeof may>[2]) => may(hoa, owner, p);
    const task = (project: string): Task => ({ id: `T-${project}`, project, title: "x", status: "review", updatedAt: "2026-10-02T09:00:00Z" }) as Task;
    const items = buildInbox({
      can,
      proposals: [{ id: 1, docKey: "project/pay/guide", status: "pending", createdAt: "2026-10-02T09:00:00Z" } as Proposal, { id: 2, docKey: "project/app/guide", status: "pending", createdAt: "2026-10-02T09:00:00Z" } as Proposal],
      reviewTasks: [task("pay"), task("app")],
      memory: [memory({ id: 1, project: "pay", status: "pending" }), memory({ id: 2, project: "app", status: "pending" })],
      gates: [
        // A task's review is code review (hers on pay); a spec step is running agents (not a reviewer's).
        { id: 7, project: "pay", taskId: "S1-T1", gate: "review", mode: "human", status: "waiting", createdAt: "2026-10-02T09:00:00Z" } as SdlcGateRecord,
        { id: 8, project: "pay", taskId: "S1", gate: "spec", mode: "human", status: "waiting", createdAt: "2026-10-02T09:00:00Z" } as SdlcGateRecord,
      ],
      leader: [{ id: 9, project: "pay", status: "proposed", createdAt: "2026-10-02T09:00:00Z" } as ChatAction, { id: 10, project: "app", status: "proposed", createdAt: "2026-10-02T09:00:00Z" } as ChatAction],
    });
    assert.deepEqual(items.map((i) => i.key).sort(), ["gate:7", "leader:9", "memory:1", "proposal:1", "review:pay:T-pay:2026-10-02T09:00:00Z"]);
  });
});
