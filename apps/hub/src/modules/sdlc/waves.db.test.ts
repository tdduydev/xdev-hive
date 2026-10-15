import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings, type SdlcItemDetail } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveDoc } from "../knowledge/index.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider, type ScmEventContext } from "../scm/index.ts";
import { onCodeRunSettled } from "./index.ts";
import { createItem, pauseItem } from "./items.ts";
import { onBaseline, type SdlcDeps, type SdlcTaskRunRequest } from "./phases.ts";
import { onSdlcMerged, type SdlcCiJob, traceCi } from "./scm.ts";
import { getTrace } from "./trace.ts";
import { runWave } from "./waves.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
const p: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
const key = (k: string) => `${k}${tag}`;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const system = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

let mem: MemoryProvider;
let queued: { data: Record<string, unknown>; startAfter: Date | undefined }[] = [];
const jobs: Jobs = {
  start: async () => {},
  stop: async () => {},
  schedule: async () => {},
  work: async () => {},
  enqueue: async (_queue, data, opts) => {
    queued.push({ data: data as Record<string, unknown>, startAfter: opts?.startAfter });
    return randomUUID();
  },
};

/** Thay `runs.queueRun`: ghi run `queued` để đợt sau thấy chỗ song song đã bị chiếm. */
const calls: SdlcTaskRunRequest[] = [];
const deps: SdlcDeps = {
  jobs,
  masterKey,
  providerFactory: () => mem,
  startTaskRun: async (tx, req) => {
    calls.push(req);
    const { rows } = await tx.execute<{ id: string }>(
      sql`insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by, owner_user_id)
          select org_id, team_id, id, project_id, 'code', 'queued', 'ai/' || key, '[]', ${req.createdBy}, ${req.ownerUserId}
          from hive.tasks where id = ${req.taskId} returning id`,
    );
    return { runId: rows[0]?.id ?? "", afterCommit: () => {} };
  },
};

async function seedSdlcProject(k: string, teamId: string, systemId: string) {
  return (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId,
      systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: key(k),
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit", modes: ["speckit"] }),
      },
    })
  ).projectId;
}

/** Hạng mục có bản tách đã baseline; cài đặt đợt ghi vào bản chụp của từng dự án trong hạng mục. */
async function itemWithTasks(
  tasks: string,
  settings: Partial<Record<"a" | "b" | "c", Record<string, unknown>>>,
  participants: string[] = [],
) {
  const item: SdlcItemDetail = await as("admin", (tx) =>
    createItem(tx, org.user("admin"), {
      projectId: p.a,
      participants,
      title: "Xuất báo cáo",
      idea: "Xuất báo cáo doanh thu theo tháng ra file CSV cho kế toán.",
      modeRef: "speckit",
      size: "M",
    }),
  );
  const docKey = item.artifacts.find((a) => a.artifactId === "tasks")?.docKey ?? "";
  await as("admin", async (tx) => {
    const doc = await saveDoc(
      tx,
      { kind: "user", userId: org.user("admin") },
      { key: docKey, content: tasks, baseVersion: 0 },
    );
    await onBaseline(tx, { docKey, version: doc.version, proposalId: randomUUID(), reviewId: randomUUID() });
  });
  for (const [k, s] of Object.entries(settings))
    await admin.query(
      "update hive.sdlc_item_projects set settings = settings || $3::jsonb where item_id = $1 and project_id = $2",
      [item.id, p[k as "a" | "b" | "c"], JSON.stringify(s)],
    );
  return item;
}

async function taskIds(itemId: string): Promise<Record<string, string>> {
  const { rows } = await admin.query(
    "select l.slice_key, l.task_id from hive.sdlc_item_tasks l where l.item_id = $1 order by l.slice_key",
    [itemId],
  );
  return Object.fromEntries(rows.map((r) => [r.slice_key, r.task_id]));
}

/** Run của task đã mở PR rồi kết luận; trả link PR. */
async function finishRun(runId: string): Promise<string> {
  const prUrl = `https://github.com/acme/${tag}/pull/${Math.floor(Math.random() * 1e6)}`;
  await admin.query("update hive.runs set state = 'succeeded', pr_url = $2 where id = $1", [runId, prUrl]);
  await admin.query(
    "update hive.tasks set status = 'review' where id = (select task_id from hive.runs where id = $1)",
    [runId],
  );
  return prUrl;
}

/**
 * Giả lập webhook merge: handler của `sdlc` chạy trước handler `runs` (task chưa `done`), rồi `runs` đặt task `done`
 * trong cùng transaction.
 */
async function merge(runId: string, prUrl: string) {
  const { rows } = await admin.query("select project_id, task_id from hive.runs where id = $1", [runId]);
  const { project_id: projectId, task_id: taskId } = rows[0];
  const number = Number(prUrl.split("/").at(-1));
  await system(async (tx) => {
    const ctx = {
      tx,
      orgId: org.orgId,
      projectId,
      deliveryRowId: randomUUID(),
      intake: {} as ScmEventContext["intake"],
      afterCommit: () => {},
    } satisfies ScmEventContext;
    await onSdlcMerged(
      {
        kind: "pull_request.merged",
        provider: "github",
        repo: `acme/${tag}`,
        actor: "dev",
        pullRequest: { number, title: "x", url: prUrl, head: "ai/x", base: "main", headSha: `sha${number}` },
      } as Parameters<typeof onSdlcMerged>[0],
      ctx,
      deps,
    );
    await tx.execute(sql`update hive.tasks set status = 'done' where id = ${taskId}`);
  });
}

const runOf = async (taskId: string) =>
  (await admin.query("select id from hive.runs where task_id = $1 order by created_at desc limit 1", [taskId])).rows[0]
    ?.id as string;

const phaseStatus = async (itemId: string) =>
  (
    await admin.query(
      `select ph.status from hive.sdlc_item_phases ph join hive.sdlc_items i on i.id = ph.item_id
       where ph.item_id = $1 and ph.kind = 'implementation'`,
      [itemId],
    )
  ).rows[0]?.status as string;

const FOUR = `# Tasks

## Phase 1: A

- [ ] T001 Bảng (FR-001)

## Phase 2: B

- [ ] T002 Hàm (FR-002)

## Phase 3: C

- [ ] T003 Lịch (FR-003)

## Phase 4: D

- [ ] T004 Xuất CSV (FR-001) (phụ thuộc T001)
`;

beforeAll(async () => {
  org = await seedOrg(admin, `swv-${tag}`);
  const teamC = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'mobile', 'Mobile') returning id", [
      org.orgId,
    ])
  ).rows[0].id;
  const systemC = (
    await admin.query(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 'app', 'App') returning id",
      [org.orgId, teamC],
    )
  ).rows[0].id;
  p.a = await seedSdlcProject("a", org.teamId, org.systemId);
  p.b = await seedSdlcProject("b", org.otherTeamId, org.otherSystemId);
  p.c = await seedSdlcProject("c", teamC, systemC);
});

beforeEach(async () => {
  calls.length = 0;
  queued = [];
  mem = createMemoryProvider("github");
  await admin.query("delete from hive.runs where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.tasks where org_id = $1", [org.orgId]);
  for (const table of ["doc_drafts", "docs"])
    await admin.query(`delete from hive.${table} where org_id = $1`, [org.orgId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("waves.run", () => {
  it("đợt 1 → merge → đợt 2, song song 2; mọi task xong thì giai đoạn triển khai đạt; truy vết đủ", async () => {
    const item = await itemWithTasks(FOUR, { a: { maxParallel: 2, autoRunWaves: true, runner: "requester" } });
    const t = await taskIds(item.id);
    const first = await as("admin", (tx) => runWave(tx, org.user("admin"), { id: item.id }, deps));
    expect(first.started.map((s) => s.taskId)).toEqual([t["phase-1-a"], t["phase-2-b"]]);
    expect(first.skipped).toEqual([
      { taskId: t["phase-3-c"], key: expect.any(String), reason: `Dự án ${key("a")} đang chạy đủ 2 run song song.` },
    ]);
    expect(calls[0]).toMatchObject({
      ownerUserId: org.user("admin"),
      createdBy: org.user("admin"),
      requiredLabels: [],
    });

    // Bấm lại khi hai run còn chạy: không còn chỗ.
    expect((await as("admin", (tx) => runWave(tx, org.user("admin"), { id: item.id }, deps))).started).toEqual([]);

    // A xong: evidence của agent thành liên kết test; merge A mở chỗ cho C (đợt 1) trước D (đợt 2, vừa hết chặn).
    const runA = first.started[0]?.runId ?? "";
    const prA = await finishRun(runA);
    await admin.query(
      "insert into hive.run_events (org_id, run_id, attempt, type, data) values ($1, $2, 1, 'agent_report', $3)",
      [org.orgId, runA, JSON.stringify({ evidence: { requirements: ["FR-001"], tests: ["report.test.ts"] } })],
    );
    await system((tx) =>
      onCodeRunSettled(tx, { id: runA, taskId: t["phase-1-a"] ?? "", projectId: p.a, state: "succeeded", prUrl: prA }),
    );
    calls.length = 0;
    await merge(runA, prA);
    expect(calls.map((c) => c.taskId)).toEqual([t["phase-3-c"]]);
    expect(calls[0]).toMatchObject({ createdBy: "system:sdlc", actorUserId: null, ownerUserId: org.user("admin") });

    // B xong và merge: D chạy.
    calls.length = 0;
    const runB = await runOf(t["phase-2-b"] ?? "");
    await merge(runB, await finishRun(runB));
    expect(calls.map((c) => c.taskId)).toEqual([t["phase-4-d"]]);
    expect(await phaseStatus(item.id)).not.toBe("approved");

    for (const slice of ["phase-3-c", "phase-4-d"]) {
      const run = await runOf(t[slice] ?? "");
      await merge(run, await finishRun(run));
    }
    expect(await phaseStatus(item.id)).toBe("approved");

    const trace = await as("admin", (tx) => getTrace(tx, org.user("admin"), { id: item.id, format: "csv" }));
    const fr1 = trace.rows.find((r) => r.requirementId === "FR-001");
    expect(fr1?.tasks.map((x) => [x.taskId, x.status])).toEqual([
      [t["phase-1-a"], "done"],
      [t["phase-4-d"], "done"],
    ]);
    expect(fr1?.tasks[0]).toMatchObject({ runId: runA, prUrl: prA, tests: ["report.test.ts"], ci: "none" });
    expect(fr1?.tasks[0]?.mergeSha).toMatch(/^sha\d+$/);
    expect(fr1).toMatchObject({ planned: true, done: true, verified: false });
    expect(trace.total).toEqual({ requirements: 3, planned: 100, done: 100, verified: 0 });
    expect(trace.csv?.split("\r\n")[0]).toContain("dự án");
  });

  it("tạm dừng: người bấm bị từ chối, merge không tự chạy đợt kế", async () => {
    const item = await itemWithTasks(FOUR, { a: { maxParallel: 1, autoRunWaves: true } });
    const t = await taskIds(item.id);
    const first = await as("admin", (tx) => runWave(tx, org.user("admin"), { id: item.id }, deps));
    expect(first.started.map((s) => s.taskId)).toEqual([t["phase-1-a"]]);
    expect(calls[0]?.ownerUserId).toBeNull();
    await as("admin", (tx) => pauseItem(tx, org.user("admin"), item.id));
    expect(await errorCode(() => as("admin", (tx) => runWave(tx, org.user("admin"), { id: item.id }, deps)))).toBe(
      "SDLC_ITEM_NOT_ACTIVE",
    );
    calls.length = 0;
    const run = first.started[0]?.runId ?? "";
    await merge(run, await finishRun(run));
    expect(calls).toEqual([]);
  });

  it("không bật autoRunWaves: merge không tự chạy", async () => {
    const item = await itemWithTasks(FOUR, { a: { maxParallel: 1, autoRunWaves: false } });
    const first = await as("admin", (tx) => runWave(tx, org.user("admin"), { id: item.id }, deps));
    calls.length = 0;
    const run = first.started[0]?.runId ?? "";
    await merge(run, await finishRun(run));
    expect(calls).toEqual([]);
  });

  it("ba dự án: merge backend mở task web và mobile, mỗi dự án tự giới hạn song song; người bấm thiếu quyền bị bỏ qua", async () => {
    const doc = `# Tasks

## Phase 1: API

- [ ] T001 API xuất báo cáo (FR-001)

## Phase 2: Web 1

Dự án: ${key("b")}

- [ ] T002 Màn xuất (FR-001) (phụ thuộc T001)

## Phase 3: Web 2

Dự án: ${key("b")}

- [ ] T003 Màn lịch (FR-002) (phụ thuộc T001)

## Phase 4: Mobile 1

Dự án: ${key("c")}

- [ ] T004 Màn xuất trên app (FR-001) (phụ thuộc T001)

## Phase 5: Mobile 2

Dự án: ${key("c")}

- [ ] T005 Màn lịch trên app (FR-002) (phụ thuộc T001)
`;
    const auto = { autoRunWaves: true };
    const item = await itemWithTasks(
      doc,
      { a: { ...auto, maxParallel: 2 }, b: { ...auto, maxParallel: 1 }, c: { ...auto, maxParallel: 2 } },
      [p.b, p.c],
    );
    const t = await taskIds(item.id);
    const first = await as("admin", (tx) => runWave(tx, org.user("admin"), { id: item.id }, deps));
    expect(first.started.map((s) => s.taskId)).toEqual([t["phase-1-api"]]);

    calls.length = 0;
    const run = first.started[0]?.runId ?? "";
    await merge(run, await finishRun(run));
    expect(calls.map((c) => c.taskId).sort()).toEqual(
      [t["phase-2-web-1"], t["phase-4-mobile-1"], t["phase-5-mobile-2"]].sort(),
    );

    // tmember chỉ ở đội của dự án a: task web còn chờ ở dự án b bị bỏ qua vì thiếu quyền, không vì song song.
    await admin.query("update hive.runs set state = 'failed' where task_id = $1", [t["phase-2-web-1"]]);
    const mine = await as("tmember", (tx) => runWave(tx, org.user("tmember"), { id: item.id }, deps));
    expect(mine.started).toEqual([]);
    expect(mine.skipped.map((s) => [s.taskId, s.reason]).sort()).toEqual(
      [
        [t["phase-2-web-1"], `Bạn không có quyền giao task ở dự án ${key("b")}.`],
        [t["phase-3-web-2"], `Bạn không có quyền giao task ở dự án ${key("b")}.`],
      ].sort(),
    );

    const byProject = await as("admin", (tx) => getTrace(tx, org.user("admin"), { id: item.id, projectId: p.b }));
    expect(byProject.byProject.map((x) => x.projectKey)).toEqual([key("b")]);
    expect(byProject.rows.flatMap((r) => r.tasks.map((x) => x.projectKey))).toEqual([key("b"), key("b")]);
  });

  it("CI của commit merge: hỏi lại khi còn chạy, xanh thì requirement đã kiểm", async () => {
    const item = await itemWithTasks(FOUR, { a: { maxParallel: 1 } });
    const t = await taskIds(item.id);
    const { rows } = await admin.query("select repo_owner, repo_name from hive.projects where id = $1", [p.a]);
    const repo = { owner: rows[0].repo_owner, name: rows[0].repo_name };
    mem.seedRepo(repo);
    const first = await as("admin", (tx) => runWave(tx, org.user("admin"), { id: item.id }, deps));
    const run = first.started[0]?.runId ?? "";
    await merge(run, await finishRun(run));
    const job = queued.map((q) => q.data).find((d) => d.kind === "trace-ci") as SdlcCiJob;
    expect(job).toMatchObject({ itemId: item.id, taskId: t["phase-1-a"], poll: 0 });

    mem.setChecks(repo, job.sha, "pending");
    queued = [];
    await traceCi({ ...deps, pool: app }, job);
    expect(queued).toEqual([{ data: { ...job, poll: 1 }, startAfter: expect.any(Date) }]);

    mem.setChecks(repo, job.sha, "success");
    await traceCi({ ...deps, pool: app }, { ...job, poll: 1 });
    const trace = await as("admin", (tx) => getTrace(tx, org.user("admin"), { id: item.id }));
    const cell = trace.rows.find((r) => r.requirementId === "FR-001")?.tasks.find((x) => x.taskId === t["phase-1-a"]);
    expect(cell?.ci).toBe("success");
  });
});
