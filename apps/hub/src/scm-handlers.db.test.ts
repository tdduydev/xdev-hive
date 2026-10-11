// Handler sự kiện Git của module runs: phát sự kiện đã chuẩn hoá qua processScmEventJob, GitProvider giả trong bộ nhớ.
import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, type IssueIntake } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import type { OutgoingMessage } from "./modules/fleet/index.ts";
import { createPool, parseMasterKey, withTenant } from "./modules/platform/index.ts";
import { createRunsEngine, type RunsEngine } from "./modules/runs/index.ts";
import {
  createMemoryProvider,
  createScmEventRegistry,
  GitProviderError,
  type MemoryProvider,
  type MemoryRepo,
  processScmEventJob,
  type ScmEvent,
} from "./modules/scm/index.ts";
import { createTask } from "./modules/tasks/index.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const quiet = { warn: () => {}, error: () => {} };
const intake: IssueIntake = { enabled: true, label: "giao-viec", mention: "hive" };

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
let repo: MemoryRepo;
let provider: MemoryProvider;
let engine: RunsEngine;
const sent: Array<{ machineId: string; msg: OutgoingMessage }> = [];
const registry = createScmEventRegistry();
let repoPath = "";

beforeAll(async () => {
  org = await seedOrg(admin, `scmh-${tag}`);
  const p = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `sh-${tag}`,
    settings: { ...defaultProjectSettings(), issueIntake: intake, defaultCli: "codex" },
  });
  projectId = p.projectId;
  repoPath = `${p.owner}/${p.repo}`;
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
  repo = provider.seedRepo({ owner: p.owner, name: p.repo });
  engine = createRunsEngine({
    pool,
    publicUrl: "https://hive.example.com",
    authSecret: "test-secret-0123456789abcdef-0123456789",
    masterKey,
    providerFactory: () => provider,
    send: (machineId, msg) => {
      sent.push({ machineId, msg });
      return true;
    },
    isConnected: () => false,
    logger: quiet,
  });
  engine.registerScmHandlers(registry);
});

afterAll(async () => {
  engine.stop();
  await Promise.all([admin.end(), pool.end()]);
});

// ---- Công cụ ------------------------------------------------------------------------------------------------

/** Ghi một delivery như endpoint webhook rồi chạy handler của nó. */
async function emit(events: ScmEvent[], opts: { intake?: IssueIntake } = {}) {
  const { rows } = await admin.query(
    `insert into hive.webhook_deliveries (org_id, project_id, provider, delivery_id, event, status)
     values ($1, $2, 'gitlab', $3, 'test', 'queued') returning id`,
    [org.orgId, projectId, randomUUID()],
  );
  return processScmEventJob(
    pool,
    registry,
    {
      orgId: org.orgId,
      projectId,
      deliveryRowId: rows[0].id,
      provider: "gitlab",
      events,
      intake: opts.intake ?? intake,
    },
    quiet,
  );
}

const base = () => ({ provider: "gitlab" as const, repo: repoPath, actor: "lan" });

function pr(kind: "pull_request.merged" | "pull_request.closed", number: number, head: string, url?: string) {
  return {
    ...base(),
    kind,
    pullRequest: {
      number,
      title: "T",
      url: url ?? `https://gitlab.com/${repoPath}/-/merge_requests/${number}`,
      head,
      base: "main",
      headSha: null,
    },
  } satisfies ScmEvent;
}

function issue(kind: "issue.opened" | "issue.labeled", number: number, labels: string[], label = "giao-viec") {
  const info = {
    number,
    title: `Lỗi số ${number}`,
    body: "Nút thanh toán không chạy",
    labels,
    author: "lan",
    url: `https://gitlab.com/${repoPath}/-/issues/${number}`,
  };
  return (
    kind === "issue.labeled" ? { ...base(), kind, issue: info, label } : { ...base(), kind, issue: info }
  ) as ScmEvent;
}

function mention(number: number, body: string): ScmEvent {
  return {
    ...base(),
    kind: "comment.mentioned",
    target: {
      type: "pull_request",
      number,
      title: "T",
      url: `https://gitlab.com/${repoPath}/-/merge_requests/${number}`,
    },
    comment: { id: randomUUID(), body, author: "lan", url: null },
  };
}

async function newTask(title: string) {
  return withTenant(pool, { userId: org.user("tmember"), orgId: org.orgId }, (tx) =>
    createTask(tx, org.user("tmember"), { projectId, title, body: "" }),
  );
}

/** Task có một run đã xong và mở PR số `number`: task chờ review như sau verifying. */
async function taskWithPr(title: string, number: number, state = "succeeded") {
  const task = await newTask(title);
  const { run } = await withTenant(pool, { userId: org.user("tmember"), orgId: org.orgId }, (tx) =>
    engine.startRun(tx, org.user("tmember"), { taskId: task.id }),
  );
  const prUrl = `https://gitlab.com/${repoPath}/-/merge_requests/${number}`;
  await admin.query("update hive.runs set state = $2, pr_url = $3 where id = $1", [run.id, state, prUrl]);
  await admin.query("update hive.tasks set status = 'review' where id = $1", [task.id]);
  return { task, runId: run.id, prUrl };
}

const taskRow = async (id: string) => (await admin.query("select * from hive.tasks where id = $1", [id])).rows[0];
const runsOf = async (taskId: string) =>
  (await admin.query("select * from hive.runs where task_id = $1 order by created_at", [taskId])).rows;
const audits = async (action: string, targetId: string) =>
  (await admin.query("select * from hive.audit_log where action = $1 and target_id = $2", [action, targetId])).rows;
const steers = async (runId: string) =>
  (await admin.query("select data from hive.run_events where run_id = $1 and type = 'steer' order by id", [runId]))
    .rows;

// ---- PR ------------------------------------------------------------------------------------------------------

describe("pull_request.merged / closed", () => {
  it("merge PR của run: task done, ghi audit và sự kiện run", async () => {
    const { task, runId, prUrl } = await taskWithPr("Merge theo pr_url", 101);
    expect(await emit([pr("pull_request.merged", 101, `ai/${task.key}`, prUrl)])).toBe("processed");
    expect((await taskRow(task.id)).status).toBe("done");
    const [audit] = await audits("task.done", task.id);
    expect(audit).toMatchObject({ actor_user_id: null, data: { pr: 101, url: prUrl, provider: "gitlab" } });
    const { rows } = await admin.query("select type from hive.run_events where run_id = $1 and type = 'pr_merged'", [
      runId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("PR không có run (mở tay từ nhánh ai/<key>): tìm task theo nhánh", async () => {
    const task = await newTask("Merge theo nhánh");
    await admin.query("update hive.tasks set status = 'review' where id = $1", [task.id]);
    await emit([pr("pull_request.merged", 102, `ai/${task.key}`)]);
    expect((await taskRow(task.id)).status).toBe("done");
  });

  it("PR không thuộc task nào thì bỏ qua", async () => {
    expect(await emit([pr("pull_request.merged", 103, "feature/khac")])).toBe("processed");
  });

  it("đóng không merge: task về todo kèm ghi chú", async () => {
    const { task, prUrl } = await taskWithPr("Đóng PR", 104);
    await emit([pr("pull_request.closed", 104, `ai/${task.key}`, prUrl)]);
    expect((await taskRow(task.id)).status).toBe("todo");
    const [audit] = await audits("task.reopen", task.id);
    expect(audit?.data.note).toContain("PR #104 bị đóng mà không merge");
  });

  it("đóng PR cũ khi task đã có run mới thì giữ nguyên", async () => {
    const { task, prUrl } = await taskWithPr("Đóng PR cũ", 105);
    await withTenant(pool, { userId: org.user("tmember"), orgId: org.orgId }, (tx) =>
      engine.startRun(tx, org.user("tmember"), { taskId: task.id }),
    );
    await admin.query("update hive.tasks set status = 'review' where id = $1", [task.id]);
    await emit([pr("pull_request.closed", 105, `ai/${task.key}`, prUrl)]);
    expect((await taskRow(task.id)).status).toBe("review");
  });
});

// ---- Issue ---------------------------------------------------------------------------------------------------

describe("issue có nhãn giao việc", () => {
  const tasksOfIssue = async (number: number) =>
    (
      await admin.query("select * from hive.tasks where project_id = $1 and source @> $2::jsonb", [
        projectId,
        JSON.stringify({ kind: "issue", provider: "gitlab", number }),
      ])
    ).rows;

  it("issue.labeled khớp nhãn: tạo task, run queued theo CLI mặc định, bình luận link tới task", async () => {
    await emit([issue("issue.labeled", 7, ["bug", "giao-viec"])]);
    const [task] = await tasksOfIssue(7);
    expect(task).toMatchObject({
      title: "Lỗi số 7",
      status: "queued",
      created_by: "gitlab:lan",
      source: { kind: "issue", provider: "gitlab", number: 7, url: `https://gitlab.com/${repoPath}/-/issues/7` },
    });
    expect(task.body).toContain("Nút thanh toán không chạy");
    const runs = await runsOf(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: "queued", cli: "codex", branch: `ai/${task.key}` });
    const comment = repo.comments.find((c) => c.number === 7);
    expect(comment?.body).toContain(`[${task.key}](https://hive.example.com/viec/${task.key})`);
    expect(comment?.pullRequest).toBe(false);
    // Bình luận của bot không được tự nhắc bot, kẻo GitLab gửi lại thành vòng lặp.
    expect(comment?.body).not.toContain("@hive");
  });

  it("issue.opened đã có nhãn (không phân biệt hoa thường) cũng tạo task", async () => {
    await emit([issue("issue.opened", 8, ["Giao-Viec"])]);
    expect(await tasksOfIssue(8)).toHaveLength(1);
  });

  it("issue đã có task thì không tạo thêm, kể cả opened và labeled tới song song", async () => {
    await Promise.all([
      emit([issue("issue.opened", 9, ["giao-viec"])]),
      emit([issue("issue.labeled", 9, ["giao-viec"])]),
    ]);
    await emit([issue("issue.labeled", 9, ["giao-viec"])]);
    expect(await tasksOfIssue(9)).toHaveLength(1);
    expect(repo.comments.filter((c) => c.number === 9)).toHaveLength(1);
  });

  it("nhãn khác, issue không có nhãn, hoặc dự án tắt giao việc từ issue: không tạo task", async () => {
    await emit([issue("issue.labeled", 10, ["bug"], "bug")]);
    await emit([issue("issue.opened", 11, [])]);
    await emit([issue("issue.labeled", 12, ["giao-viec"])], { intake: { ...intake, enabled: false } });
    for (const n of [10, 11, 12]) expect(await tasksOfIssue(n)).toHaveLength(0);
  });

  it("bình luận lỗi thì task vẫn được tạo, delivery vẫn processed", async () => {
    provider.fail("commentOnIssue", new GitProviderError("forbidden", "thiếu quyền"));
    try {
      expect(await emit([issue("issue.labeled", 13, ["giao-viec"])])).toBe("processed");
    } finally {
      provider.fail("commentOnIssue", null);
    }
    expect(await tasksOfIssue(13)).toHaveLength(1);
  });
});

// ---- Nhắc @hive trên PR --------------------------------------------------------------------------------------

describe("bình luận nhắc @hive trên PR của run", () => {
  it("run đã xong: chạy lại run mới mang chỉ dẫn, trả lời trên PR", async () => {
    const { task, runId } = await taskWithPr("Chạy lại", 201);
    await emit([mention(201, "@hive đổi tên biến cho rõ hơn")]);
    const runs = await runsOf(task.id);
    expect(runs).toHaveLength(2);
    const fresh = runs[1];
    expect(fresh.id).not.toBe(runId);
    expect(fresh.state).toBe("queued");
    expect(await steers(fresh.id)).toEqual([
      { data: { input: "@hive đổi tên biến cho rõ hơn", by: "gitlab:lan", delivered: false } },
    ]);
    expect((await taskRow(task.id)).status).toBe("queued");
    const reply = repo.comments.find((c) => c.number === 201);
    expect(reply).toMatchObject({ pullRequest: true });
    expect(reply?.body).toContain(`Đã chạy lại task ${task.key}`);
  });

  it("run đang chạy trên máy: gửi steer tới máy, không tạo run mới", async () => {
    const { task, runId } = await taskWithPr("Đang chạy", 202);
    const machineId = randomUUID();
    await admin.query("update hive.runs set state = 'running', machine_id = $2 where id = $1", [runId, machineId]);
    sent.length = 0;
    await emit([mention(202, "@hive nhớ thêm test")]);
    expect(await runsOf(task.id)).toHaveLength(1);
    expect(sent).toEqual([{ machineId, msg: { type: "steer", runId, input: "@hive nhớ thêm test" } }]);
    expect(await steers(runId)).toEqual([
      { data: { input: "@hive nhớ thêm test", by: "gitlab:lan", delivered: true } },
    ]);
    expect(repo.comments.find((c) => c.number === 202)?.body).toContain("Đã chuyển chỉ dẫn");
  });

  it("run mới chưa tới máy: chỉ dẫn được đưa vào prompt khi giao", async () => {
    const { task } = await taskWithPr("Chờ máy", 203);
    await emit([mention(203, "@hive làm lần 1")]);
    await emit([mention(203, "@hive và lần 2")]);
    const runs = await runsOf(task.id);
    expect(runs).toHaveLength(2);
    expect((await steers(runs[1].id)).map((r) => r.data.input)).toEqual(["@hive làm lần 1", "@hive và lần 2"]);
  });

  it("task đã xong thì không chạy lại; PR không thuộc run nào thì bỏ qua", async () => {
    const { task } = await taskWithPr("Đã xong", 204);
    await admin.query("update hive.tasks set status = 'done' where id = $1", [task.id]);
    await emit([mention(204, "@hive làm thêm")]);
    expect(await runsOf(task.id)).toHaveLength(1);
    expect(repo.comments.find((c) => c.number === 204)?.body).toContain("đã xong");
    const before = repo.comments.length;
    await emit([mention(299, "@hive ai đây")]);
    expect(repo.comments.length).toBe(before);
  });
});
