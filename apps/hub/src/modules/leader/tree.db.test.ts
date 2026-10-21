// Cây giao việc của Leader (specs/028): liên kết ghi khi Leader tạo task, giao run; dựng cây theo quyền; gộp sự kiện
// sub-agent; hub kiểm dạng và che mô tả sub-agent trước khi lưu.
import { randomBytes, randomUUID } from "node:crypto";
import { type LeaderAction, SECRET_MASK } from "@xdev-hive/contracts";
import { PROTOCOL_VERSION } from "@xdev-hive/contracts/worker-protocol";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import type { AuthedMachine } from "../fleet/index.ts";
import { createPool, parseMasterKey, withTenant } from "../platform/index.ts";
import { createRunsEngine, type RunsEngine } from "../runs/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import { executeLeaderAction } from "./actions.ts";
import { approveApproval } from "./service.ts";
import { delegationLinks, delegationTree, foldSubagents } from "./tree.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const sent: { machineId: string; msg: unknown }[] = [];

let org: OrgFixture & { user: (n: string) => string };
let other: OrgFixture & { user: (n: string) => string };
let engine: RunsEngine;
let home = "";
let crm = "";
let threadId = "";
let otherThreadId = "";

const act = (who: string, action: LeaderAction, thread?: string) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) =>
    executeLeaderAction(tx, org.user(who), action, engine, {}, thread),
  );
const tree = (who: string, id = threadId) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) => delegationTree(tx, org.user(who), id));
const links = (who: string, input: { taskId?: string; runId?: string }) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) => delegationLinks(tx, org.user(who), input));

async function newThread(orgId: string, projectId: string | null, title: string) {
  const { rows } = await admin.query(
    "insert into hive.chat_threads (org_id, project_id, created_by, title) values ($1, $2, 'u', $3) returning id",
    [orgId, projectId, title],
  );
  return rows[0].id as string;
}

async function createTaskBy(who: string, projectId: string, title: string, thread?: string) {
  const { result } = await act(who, { type: "task.create", projectId, title, body: "" }, thread);
  return (result as { task: { id: string } }).task.id;
}

async function dispatch(who: string, taskId: string, thread?: string) {
  const { result } = await act(who, { type: "run.dispatch", taskId }, thread);
  return (result as { run: { id: string; taskId: string } }).run.id;
}

/** Run con (review, plan) hub tạo khi verify; ở đây chèn thẳng cho gọn. */
async function childRun(parentId: string, kind: "review" | "plan", state = "running") {
  const { rows } = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, parent_run_id, state, branch, policy_snapshot, created_by)
     select org_id, team_id, task_id, project_id, $2, id, $3, branch, '[]'::jsonb, created_by from hive.runs where id = $1
     returning id`,
    [parentId, kind, state],
  );
  return rows[0].id as string;
}

const finish = (runId: string, state = "succeeded") =>
  admin.query("update hive.runs set state = $2, finished_at = now() where id = $1", [runId, state]);

let seq = 0;
async function subagentEvent(runId: string, data: Record<string, unknown>, attempt = 1) {
  seq += 1;
  await admin.query(
    "insert into hive.run_events (org_id, run_id, attempt, seq, type, data) select org_id, id, $2, $3, 'subagent', $4 from hive.runs where id = $1",
    [runId, attempt, seq, JSON.stringify(data)],
  );
}

const sub = (id: string, phase: "start" | "end" | "unsupported", extra: Record<string, unknown> = {}) => ({
  id,
  parentId: null,
  phase,
  type: "Explore",
  description: `Tìm ${id}`,
  status: phase === "end" ? "completed" : "running",
  depth: 1,
  ...extra,
});

beforeAll(async () => {
  org = await seedOrg(admin, `ltr-${tag}`);
  other = await seedOrg(admin, `ltr-o-${tag}`);
  const project = (teamId: string, systemId: string, key: string) =>
    seedProject(admin, app, {
      orgId: org.orgId,
      teamId,
      systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key,
    });
  home = (await project(org.teamId, org.systemId, `lt${tag}`)).projectId;
  crm = (await project(org.otherTeamId, org.otherSystemId, `lc${tag}`)).projectId;
  const provider = createMemoryProvider("gitlab", ["xdev-team"]);
  engine = createRunsEngine({
    pool: app,
    publicUrl: "http://hub.test",
    authSecret: "test-secret-0123456789abcdef-0123456789",
    masterKey,
    providerFactory: () => provider,
    logger: quiet,
    send: (machineId, msg) => {
      sent.push({ machineId, msg });
      return true;
    },
    isConnected: () => false,
  });
  threadId = await newThread(org.orgId, home, "Phiên giao việc");
  otherThreadId = await newThread(other.orgId, null, "Phiên tổ chức khác");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("ghi liên kết giao việc", () => {
  it("task.create và run.dispatch có threadId thì ghi liên kết; không có threadId thì không", async () => {
    const thread = await newThread(org.orgId, home, "Liên kết");
    const taskId = await createTaskBy("tmember", home, "Có liên kết", thread);
    const runId = await dispatch("tmember", taskId, thread);
    const unlinked = await createTaskBy("tmember", home, "Không liên kết");

    const { rows } = await admin.query(
      "select kind, task_id, run_id, created_by from hive.leader_delegations where thread_id = $1 order by created_at",
      [thread],
    );
    expect(rows).toEqual([
      { kind: "task", task_id: taskId, run_id: null, created_by: org.user("tmember") },
      { kind: "run", task_id: taskId, run_id: runId, created_by: org.user("tmember") },
    ]);
    const none = await admin.query("select 1 from hive.leader_delegations where task_id = $1", [unlinked]);
    expect(none.rowCount).toBe(0);
    await finish(runId);
  });

  it("duyệt đề xuất tạo task ghi liên kết với phiên của đề xuất", async () => {
    const thread = await newThread(org.orgId, home, "Duyệt");
    const action: LeaderAction = { type: "task.create", projectId: home, title: "Qua duyệt", body: "" };
    const { rows } = await admin.query(
      "insert into hive.approvals (org_id, thread_id, action, expires_at) values ($1, $2, $3, now() + interval '1 day') returning id",
      [org.orgId, thread, JSON.stringify(action)],
    );
    const { response } = await withTenant(app, { userId: org.user("tmember"), orgId: org.orgId }, (tx) =>
      approveApproval(engine, tx, org.user("tmember"), rows[0].id),
    );
    const taskId = (response.result as { task: { id: string } }).task.id;
    const linked = await admin.query("select kind from hive.leader_delegations where thread_id = $1 and task_id = $2", [
      thread,
      taskId,
    ]);
    expect(linked.rows).toEqual([{ kind: "task" }]);
  });

  it("xoá run chỉ bỏ run_id, xoá phiên thì xoá liên kết", async () => {
    const thread = await newThread(org.orgId, home, "Xoá");
    const taskId = await createTaskBy("tmember", home, "Sẽ xoá run", thread);
    const runId = await dispatch("tmember", taskId, thread);
    await admin.query("delete from hive.runs where id = $1", [runId]);
    const { rows } = await admin.query(
      "select kind, run_id, org_id from hive.leader_delegations where thread_id = $1 order by created_at",
      [thread],
    );
    expect(rows.map((r) => [r.kind, r.run_id, r.org_id])).toEqual([
      ["task", null, org.orgId],
      ["run", null, org.orgId],
    ]);
    await admin.query("delete from hive.chat_threads where id = $1", [thread]);
    const gone = await admin.query("select 1 from hive.leader_delegations where thread_id = $1", [thread]);
    expect(gone.rowCount).toBe(0);
  });
});

describe("leader.tree.get", () => {
  let leaderTask = "";
  let userTask = "";
  let untracked = "";
  let hiddenTask = "";
  let codeRun = "";
  let reviewRun = "";
  let planRun = "";
  let userTaskRun = "";
  let unsupportedRun = "";

  beforeAll(async () => {
    leaderTask = await createTaskBy("tmember", home, "Leader tạo", threadId);
    codeRun = await dispatch("tmember", leaderTask, threadId);
    // Mỗi run cha chỉ một run con đang sống (runs_review_active): review đã xong, plan còn chạy.
    reviewRun = await childRun(codeRun, "review", "succeeded");
    planRun = await childRun(codeRun, "plan");
    // Người tạo task, Leader chỉ giao run.
    userTask = await createTaskBy("tmember", home, "Người tạo");
    userTaskRun = await dispatch("tmember", userTask, threadId);
    // Run cũ không có liên kết với phiên nào.
    untracked = await createTaskBy("tmember", home, "Không liên quan");
    await finish(await dispatch("tmember", untracked));
    // Task của đội khác: tmember không có vai trò ở đội crm.
    hiddenTask = await createTaskBy("oadmin", crm, "Đội khác", threadId);
    await dispatch("oadmin", hiddenTask, threadId);

    await subagentEvent(codeRun, sub("s1", "start"));
    await subagentEvent(codeRun, sub("s2", "start", { parentId: "s1", depth: 2 }));
    await subagentEvent(codeRun, sub("s1", "end", { tokens: 1200, toolUses: 7, durationMs: 4100 }));
    await subagentEvent(codeRun, { garbage: true });
    unsupportedRun = reviewRun;
    await subagentEvent(reviewRun, sub("x", "unsupported", { status: "unknown" }));
  });

  it("dựng phiên → task → run (run con trỏ về run cha), task Leader tạo và task người tạo", async () => {
    const t = await tree("tmember");
    expect(t.thread).toMatchObject({ id: threadId, title: "Phiên giao việc" });
    expect(t.tasks.map((x) => [x.id, x.createdBy])).toEqual([
      [leaderTask, "leader"],
      [userTask, "user"],
    ]);
    const first = t.tasks[0];
    expect(first?.projectKey).toBe(`lt${tag}`);
    expect(first?.runs.map((r) => [r.id, r.kind, r.parentRunId])).toEqual([
      [codeRun, "code", null],
      [reviewRun, "review", codeRun],
      [planRun, "plan", codeRun],
    ]);
    expect(t.tasks[1]?.runs.map((r) => r.id)).toEqual([userTaskRun]);
    expect(t.tasks.some((x) => x.id === untracked)).toBe(false);
  });

  it("task, run của đội người xem không có vai trò bị ẩn và đếm vào hidden", async () => {
    const t = await tree("tmember");
    expect(t.tasks.some((x) => x.id === hiddenTask)).toBe(false);
    expect(t.hidden).toBe(2);
    const seen = await tree("admin");
    expect(seen.tasks.some((x) => x.id === hiddenTask)).toBe(true);
    expect(seen.hidden).toBe(0);
  });

  it("gộp sự kiện sub-agent theo seq; sự kiện sai dạng bị bỏ; không có sự kiện thì null", async () => {
    const t = await tree("tmember");
    const runs = t.tasks.flatMap((x) => x.runs);
    const code = runs.find((r) => r.id === codeRun);
    expect(code?.subagents).toEqual([
      {
        id: "s1",
        parentId: null,
        type: "Explore",
        description: "Tìm s1",
        status: "completed",
        depth: 1,
        tokens: 1200,
        toolUses: 7,
        durationMs: 4100,
      },
      {
        id: "s2",
        parentId: "s1",
        type: "Explore",
        description: "Tìm s2",
        status: "running",
        depth: 2,
        tokens: null,
        toolUses: null,
        durationMs: null,
      },
    ]);
    expect(code?.subagentsUnsupported).toBe(false);
    const unsupported = runs.find((r) => r.id === unsupportedRun);
    expect(unsupported).toMatchObject({ subagentsUnsupported: true, subagents: [] });
    expect(runs.find((r) => r.id === planRun)?.subagents).toBeNull();
    expect(t.active).toBe(true);
  });

  it("run đã kết thúc mà sub-agent chưa end thì unknown; hết việc chạy thì active false", async () => {
    for (const id of [codeRun, reviewRun, planRun, userTaskRun]) await finish(id);
    await admin.query("update hive.runs set state = 'failed', result = $2 where id = $1", [
      userTaskRun,
      JSON.stringify({ exit: 1, commitCount: 0, changedFiles: [], checks: [], reasons: ["Test hỏng"] }),
    ]);
    const t = await tree("tmember");
    const runs = t.tasks.flatMap((x) => x.runs);
    expect(runs.find((r) => r.id === codeRun)?.subagents?.map((s) => [s.id, s.status])).toEqual([
      ["s1", "completed"],
      ["s2", "unknown"],
    ]);
    expect(runs.find((r) => r.id === userTaskRun)?.error).toBe("Test hỏng");
    expect(t.active).toBe(false);
  });

  it("phiên không có hay của tổ chức khác thì NOT_FOUND", async () => {
    expect(await errorCode(() => tree("tmember", randomUUID()))).toBe("LEADER_THREAD_NOT_FOUND");
    expect(await errorCode(() => tree("tmember", otherThreadId))).toBe("LEADER_THREAD_NOT_FOUND");
  });

  it("tree.links tìm phiên theo task và theo run (kể cả run người tự giao của task trong cây)", async () => {
    expect(await links("tmember", { taskId: leaderTask })).toEqual([{ threadId, title: "Phiên giao việc" }]);
    expect(await links("tmember", { runId: reviewRun })).toEqual([{ threadId, title: "Phiên giao việc" }]);
    expect(await links("tmember", { taskId: untracked })).toEqual([]);
    expect(await links("tmember", {})).toEqual([]);
    expect(await errorCode(() => links("tmember", { taskId: hiddenTask }))).toBe("TASK_NOT_FOUND");
  });
});

describe("foldSubagents", () => {
  const ev = (data: Record<string, unknown>, attempt = 1) => ({ runId: "r", attempt, data });

  it("sub-agent đang chạy của lần thử cũ là unknown dù run còn chạy", () => {
    const out = foldSubagents({ attempt: 2, state: "running" }, [ev(sub("a", "start"), 1), ev(sub("b", "start"), 2)]);
    expect(out.subagents?.map((s) => [s.id, s.status])).toEqual([
      ["a", "unknown"],
      ["b", "running"],
    ]);
  });

  it("end không có start vẫn thành nút", () => {
    const out = foldSubagents({ attempt: 1, state: "succeeded" }, [ev(sub("a", "end", { status: "failed" }))]);
    expect(out.subagents?.[0]).toMatchObject({ id: "a", status: "failed" });
  });
});

describe("hub nhận sự kiện subagent", () => {
  const machineId = randomUUID();
  let runId = "";
  const machine = (): AuthedMachine => ({
    id: machineId,
    orgId: org.orgId,
    teamId: org.teamId,
    name: "may-test",
    kind: "worker" as AuthedMachine["kind"],
  });
  const send = (n: number, data: Record<string, unknown>) =>
    engine.handlers.onMessage(machine(), {
      type: "run_event",
      v: PROTOCOL_VERSION,
      id: randomUUID(),
      runId,
      attempt: 1,
      seq: n,
      event: "subagent",
      data,
    });

  beforeAll(async () => {
    const taskId = await createTaskBy("tmember", home, "Nhận sự kiện");
    runId = await dispatch("tmember", taskId);
    await admin.query("update hive.runs set state = 'running', machine_id = $2 where id = $1", [runId, machineId]);
  });

  it("che secret trong mô tả, cắt 120 ký tự, bỏ trường lạ", async () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const description = `Đẩy nhánh bằng ${token} ${"x".repeat(60)}`;
    await send(1, { ...sub("s1", "start"), description, prompt: "không được lưu" });
    const { rows } = await admin.query("select data from hive.run_events where run_id = $1 and seq = 1", [runId]);
    const data = rows[0].data as Record<string, unknown>;
    expect(String(data.description)).not.toContain(token);
    expect(String(data.description)).toContain(SECRET_MASK);
    expect(String(data.description).length).toBeLessThanOrEqual(120);
    expect(data).not.toHaveProperty("prompt");
  });

  it("dữ liệu sai dạng thì bỏ sự kiện nhưng vẫn ack", async () => {
    sent.length = 0;
    await send(2, { id: "s2", phase: "start" });
    const { rowCount } = await admin.query("select 1 from hive.run_events where run_id = $1 and seq = 2", [runId]);
    expect(rowCount).toBe(0);
    expect(sent).toContainEqual({ machineId, msg: { type: "ack", runId, uptoSeq: 2 } });
  });
});
