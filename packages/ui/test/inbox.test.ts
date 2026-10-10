import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { may, permissionsOn, type ImplementationPlan, type Actor, type AgentRun, type ChatAction, type HubAlert, type HubInfo, type Memory, type Permission, type Proposal, type RunRecord, type SdlcGateRecord, type Task } from "@xdev-hive/core";
import { buildInbox, groupInbox, groupSections, highestRole, inboxGroup, inboxProject, inboxSection, roleOfPermissions, shortAgo, todayDot, type InboxItem, type InboxKind } from "#ui/lib/inbox.ts";

const run = (over: Partial<AgentRun>): AgentRun => ({ id: "R-1", project: "demo", taskId: "T-1", createdAt: "2026-09-30T10:00:00Z", mrUrl: null, pipelineStatus: null, ...over }) as AgentRun;
const memory = (over: Partial<Memory>): Memory => ({ id: 1, project: "demo", kind: "decision", content: "x", author: "a", status: "approved", createdAt: "2026-09-30T09:00:00Z", conflictsWith: [], ...over }) as Memory;

describe("inbox", () => {
  it("mirrors hub health AttentionList entries and backup overdue alerts", () => {
    const hub = {
      startedAt: "2026-10-01T00:00:00Z",
      files: { lastError: "store unavailable" },
      search: { lastError: "index failed" },
      deployLog: { startedAt: "2026-10-02T00:00:00Z", errors: 2 },
    } as HubInfo;
    const backup = { id: 3, rule: "backup_overdue", key: "backup", severity: "medium", vars: { dir: "/backups", hours: 8 }, project: null, openedAt: "2026-10-02T01:00:00Z", lastSeenAt: "2026-10-02T01:00:00Z", resolvedAt: null, resolvedBy: null, ackedBy: null, ackedAt: null } as HubAlert;
    const items = buildInbox({ hubInfo: hub, alerts: [backup] });
    assert.deepEqual(items.map((item) => item.key).sort(), ["alert:3", "hubIssue:deploy:2026-10-02T00:00:00Z:2", "hubIssue:files:store unavailable", "hubIssue:search:index failed"].sort());
    assert.deepEqual(items.map((item) => inboxGroup(item)).sort(), ["watch", "watch", "watch", "watch"]);
  });
  it("keeps service proposals in their service and hub-only proposals in the shared scope", () => {
    const action = (project: string): ChatAction => ({ id: project === "*" ? 1 : 2, project, threadId: 4, status: "proposed", createdAt: "2026-10-07T00:00:00Z" }) as ChatAction;
    const items = buildInbox({ leader: [action("*"), action("pay")] });
    assert.deepEqual(items.map((item) => inboxProject(item)), [null, "pay"]);
  });
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

  it("recognizes the QA permission set and gives QA gates their own Today group", () => {
    assert.equal(roleOfPermissions(new Set<Permission>(["view", "qaVerify", "codeReview"])), "qa");
    assert.equal(roleOfPermissions(new Set<Permission>(["view", "qaVerify", "codeReview", "projectSettings"])), "lead");
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

  it("lists a task's newest hub run when it waits for a person, for whoever may dispatch runs (roadmap 49g)", () => {
    const hub = (over: Partial<RunRecord>): RunRecord =>
      ({ machineId: "m1", machine: "mbp", runId: "R-1", project: "pay", taskId: "T-1", taskTitle: "Đổi trả", role: "implement", status: "succeeded", summary: null, error: null, mr: null, createdAt: "2026-10-06T08:00:00Z", updatedAt: "2026-10-06T08:10:00Z", ...over }) as RunRecord;
    const runs = [
      // T-1 asked, then a newer run answered: nothing waits any more.
      hub({ runId: "R-1", summary: "Cần bạn xác nhận cách làm" }),
      hub({ runId: "R-2", createdAt: "2026-10-06T09:00:00Z", summary: "ĐÃ LÀM: xong" }),
      hub({ runId: "R-3", taskId: "T-2", status: "rate_limited", updatedAt: "2026-10-06T09:30:00Z" }),
      hub({ runId: "R-4", taskId: "T-3", project: "app", summary: "need your input" }),
    ];
    const lan: Actor = { name: "lan", role: "member", access: { projects: { pay: "lead", app: "reviewer" } } };
    const items = buildInbox({ hubRuns: runs, can: (owner, p) => may(lan, owner, p) });
    assert.deepEqual(items.map((i) => i.kind === "waitingRun" && [i.run.runId, i.reason]), [["R-3", "quota"]]);
    assert.equal(inboxProject(items[0]!), "pay");
    assert.equal(inboxGroup(items[0]!), "agent");
  });

  it("groups by what the person does, in the order of their highest role in the scope (roadmap 49g)", () => {
    const items = buildInbox({
      reviewTasks: [{ id: "T-1", project: "pay", title: "x", status: "review", updatedAt: "2026-10-06T09:00:00Z" } as Task],
      gates: [
        { id: 1, project: "pay", taskId: "S1", gate: "spec", mode: "human", status: "waiting", createdAt: "2026-10-06T08:00:00Z" } as SdlcGateRecord,
        { id: 2, project: "pay", taskId: "S1-T1", gate: "merge", mode: "human", status: "waiting", createdAt: "2026-10-06T07:00:00Z" } as SdlcGateRecord,
      ],
      assignedTasks: [{ id: "T-9", project: "pay", title: "y", status: "todo", updatedAt: "2026-10-06T06:00:00Z", agent: { machineId: "m", profileId: "p", by: "lan", at: "x", hold: { code: "offline" } } } as unknown as Task],
      alerts: [{ id: 3, project: "pay", severity: "low", openedAt: "2026-10-06T05:00:00Z", resolvedAt: null, ackedBy: null } as HubAlert],
    });
    const shape = (role: Parameters<typeof groupInbox>[1]) => groupInbox(items, role).map((g) => [g.group, g.items.map((i) => i.key.split(":").slice(0, 2).join(":"))]);
    assert.deepEqual(shape("lead"), [
      ["decide", ["gate:1"]],
      ["agent", ["agentHold:T-9"]],
      ["review", ["review:pay", "gate:2"]],
      ["watch", ["alert:3"]],
    ]);
    assert.deepEqual(shape("reviewer").map(([g]) => g), ["review", "decide", "agent", "watch"]);
    assert.deepEqual(shape("member").map(([g]) => g), ["agent", "review", "decide", "watch"]);
    assert.deepEqual(groupInbox([], "lead"), [], "no empty group");
  });

  it("takes the highest role across the scope's projects, a custom grant by what it allows", () => {
    const hoa: Actor = { name: "hoa", role: "member", access: { projects: { pay: "reviewer", app: "viewer", ops: { permissions: ["view", "taskWork"] } } } };
    const on = (...owners: Array<string | null>) => highestRole(owners.map((o) => permissionsOn(hoa, o)));
    assert.equal(on("pay", "app"), "reviewer");
    assert.equal(on("app"), "viewer");
    assert.equal(on("ops"), "member");
    assert.equal(on("gone"), "viewer");
    assert.equal(roleOfPermissions(new Set<Permission>(["view", "projectSettings"])), "lead");
    assert.equal(highestRole([permissionsOn({ name: "admin", role: "admin" }, null)]), "lead");
  });
});


describe("plan approval inbox", () => {
  it("shows only waiting plans to people allowed to dispatch; revisions have new keys", () => {
    const plan: ImplementationPlan = { id: 7, project: "demo", taskId: "T-1", taskTitle: "Settings", machineId: "runner", requestId: 1, runId: "R-plan", status: "waiting", text: "Plan", note: null, revision: 1, createdAt: "2026-10-06T08:00:00Z", readyAt: "2026-10-06T08:01:00Z", deadline: null, decidedAt: null, decidedBy: null };
    const [item] = buildInbox({ plans: [plan] });
    assert.equal(item?.kind, "plan"); assert.equal(inboxProject(item!), "demo"); assert.equal(inboxGroup(item!), "decide");
    assert.notEqual(buildInbox({ plans: [{ ...plan, revision: 2 }] })[0]?.key, item?.key);
    assert.deepEqual(buildInbox({ plans: [plan], can: (_, permission) => permission === "view" }), []);
    assert.deepEqual(buildInbox({ plans: [{ ...plan, status: "approved" }] }), []);
  });
});

describe("Hôm nay sections", () => {
  /** One item of a kind, with only what inboxSection reads. */
  const of = (kind: InboxKind, extra: Record<string, unknown> = {}) => ({ kind, key: `${kind}:${JSON.stringify(extra)}`, tone: "info", at: "", scope: "", ...extra }) as unknown as InboxItem;
  const failing = { run: run({ ciFix: null, status: "succeeded" } as Partial<AgentRun>) };

  it("puts what waits on a human yes/no in Để bạn quyết", () => {
    for (const kind of ["review", "plan", "proposal", "gate", "leader", "request", "machine", "memory", "conflict", "cleanup"] as const) assert.equal(inboxSection(of(kind)), "decide", kind);
  });

  it("puts what broke or stopped in Lỗi cần xử lý", () => {
    assert.equal(inboxSection(of("ci", failing)), "fix");
    assert.equal(inboxSection(of("agentHold")), "fix");
    assert.equal(inboxSection(of("waitingRun", { reason: "question" })), "fix");
    assert.equal(inboxSection(of("waitingRun", { reason: "ci" })), "fix");
    assert.equal(inboxSection(of("hubIssue")), "fix");
    assert.equal(inboxSection(of("alert")), "fix");
    assert.equal(inboxSection(of("releaseFailure", { task: { id: "OPS-release-7" } })), "fix");
  });

  it("puts what already moves without the person in Để biết", () => {
    const fixing = run({ status: "running", ciFix: { n: 1, max: 3, jobs: [] } } as unknown as Partial<AgentRun>);
    assert.equal(inboxSection(of("ci", { run: fixing })), "fyi", "an agent is fixing the pipeline");
    assert.equal(inboxSection(of("waitingRun", { reason: "quota" })), "fyi", "the run resumes when its quota is back");
    assert.equal(inboxSection(of("releaseFailure", { task: { id: "OPS-release-log-7" } })), "fyi", "only a logged warning");
  });

  it("keeps all three sections in order, empty ones too, and the items' newest-first order", () => {
    const items = buildInbox({
      memory: [memory({ id: 1, status: "pending" }), memory({ id: 2, conflictsWith: [3] }), memory({ id: 3, conflictsWith: [2], createdAt: "2026-09-30T08:00:00Z" })],
      runs: [run({ id: "R-9", mrUrl: "https://git/mr/9", pipelineStatus: "failed" })],
    });
    const sections = groupSections(items);
    assert.deepEqual(sections.map((g) => [g.section, g.items.map((i) => i.kind)]), [["decide", ["conflict", "memory"]], ["fix", ["ci"]], ["fyi", []]]);
    assert.deepEqual(groupSections([]).map((g) => g.items.length), [0, 0, 0]);
    assert.equal(todayDot(sections[1]!.items[0]!), "red");
  });
});
