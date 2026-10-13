// Agent đề xuất skill sau việc khó (specs/014): chọn run đáng học, lô theo ngày, hạn mức, bỏ trùng, duyệt mở PR.
import { randomBytes, randomUUID } from "node:crypto";
import { agentPolicyInput, DEFAULT_AGENT_POLICY, type SkillProposalSubmitInput } from "@xdev-hive/contracts";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveSkill } from "../knowledge/index.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { runs } from "../runs/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import {
  approveLearnedProposal,
  deliverLearnedProposal,
  listLearnedProposals,
  markRunForLearning,
  rejectLearnedProposal,
  runSkillLearningTick,
  skillLearningStats,
} from "./index.ts";
import { learnedSkillProposals, skillLearningBatches } from "./schema.ts";
import { ingestSkillLearning, planSkillLearning, type SkillLearningDeps, type SkillRunPort } from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const mem = createMemoryProvider("gitlab", ["xdev-team"]);

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

type World = {
  org: OrgFixture & { user: (n: string) => string };
  projectId: string;
  projectKey: string;
  deps: SkillLearningDeps;
  /** Đặt false để giả lập không có máy dùng chung nào. */
  machine: { online: boolean };
  now: { value: Date };
  created: string[];
  queued: object[];
};

const POLICY = (skillLearning: { enabled: boolean; maxPerDay: number }) =>
  agentPolicyInput.parse({ ...DEFAULT_AGENT_POLICY, skillLearning });

/** Một tổ chức riêng (hạn mức tính theo tổ chức nên mỗi nhóm test cần tổ chức của mình) kèm một dự án. */
async function world(opts: { enabled?: boolean; maxPerDay?: number } = {}): Promise<World> {
  const tag = randomUUID().slice(0, 8);
  const org = await seedOrg(admin, `sl-${tag}`);
  const projectKey = `sl${tag}`;
  const p = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  await admin.query("insert into hive.agent_policies (org_id, policy) values ($1, $2)", [
    org.orgId,
    JSON.stringify(POLICY({ enabled: opts.enabled ?? true, maxPerDay: opts.maxPerDay ?? 5 })),
  ]);
  const machine = { online: true };
  const created: string[] = [];
  const queued: object[] = [];
  const now = { value: new Date() };
  // Cổng tạo run: cùng hình với engine.createSkillProposalRun nhưng chỉ chèn dòng run, để test không cần máy thật.
  const port: SkillRunPort = {
    async createRun(tx, input) {
      if (!machine.online) return { ok: false, reason: "no_machine" };
      const [row] = await tx
        .insert(runs)
        .values({
          orgId: sql`hive.ctx_org()`,
          teamId: org.teamId,
          taskId: null,
          projectId: input.projectId,
          kind: "skill_proposal",
          branch: `skill-learning/${input.batchId}`,
          policySnapshot: [],
          createdBy: "system",
        })
        .returning();
      if (!row) throw new Error("không tạo được run");
      created.push(input.prompt);
      return { ok: true, runId: row.id, afterCommit: () => {} };
    },
  };
  const jobs = {
    enqueue: async (_q: string, data: object) => {
      queued.push(data);
      return randomUUID();
    },
  } as unknown as Jobs;
  const deps: SkillLearningDeps = {
    pool,
    masterKey,
    providerFactory: () => mem,
    publicUrl: "https://hive.example",
    jobs,
    runs: port,
    now: () => now.value,
  };
  return { org, projectId: p.projectId, projectKey, deps, machine, now, created, queued };
}

let taskSeq = 0;
/** Một run code đã xong của một task (task mới nếu không truyền). */
async function seedRun(
  w: World,
  o: {
    taskId?: string;
    attempt?: number;
    state?: string;
    costUsd?: number | null;
    tokens?: number;
    finishedAt?: Date;
    result?: object;
  } = {},
): Promise<{ runId: string; taskId: string }> {
  let taskId = o.taskId;
  if (!taskId) {
    taskSeq += 1;
    taskId = (
      await admin.query(
        `insert into hive.tasks (org_id, team_id, project_id, number, key, title, body, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, 'seed') returning id`,
        [w.org.orgId, w.org.teamId, w.projectId, taskSeq, `T-${taskSeq}`, `Việc ${taskSeq}`, "Sửa lỗi làm tròn tiền"],
      )
    ).rows[0].id as string;
  }
  const { rows } = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, branch, policy_snapshot, created_by, state, attempt,
       cost_usd, tokens_in, tokens_out, finished_at, result)
     values ($1, $2, $3, $4, 'ai/x', '[]', 'u', $5, $6, $7, $8, 0, $9, $10) returning id`,
    [
      w.org.orgId,
      w.org.teamId,
      taskId,
      w.projectId,
      o.state ?? "succeeded",
      o.attempt ?? 1,
      o.costUsd === undefined ? 0.1 : o.costUsd,
      o.tokens ?? 1000,
      o.finishedAt ?? new Date(w.now.value.getTime() - 3_600_000),
      o.result ? JSON.stringify(o.result) : null,
    ],
  );
  return { runId: rows[0].id as string, taskId };
}

/** Task đã chạy lại: `failures` run thất bại rồi một run thành công, nên đáng học vì thử lại. */
async function seedRetriedTask(w: World, failures = 2) {
  const first = await seedRun(w, { state: "failed", result: { reasons: ["Test lỗi: làm tròn sai"], checks: [] } });
  for (let i = 1; i < failures; i++) await seedRun(w, { taskId: first.taskId, state: "failed" });
  const last = await seedRun(w, { taskId: first.taskId });
  return { taskId: first.taskId, runId: last.runId };
}

/** Giả lập agent `skill_proposal` đã nộp xong: run succeeded kèm sự kiện báo cáo. */
async function finishAgent(w: World, runId: string, report: SkillProposalSubmitInput, state = "succeeded") {
  await admin.query("update hive.runs set state = $2, finished_at = now() where id = $1", [runId, state]);
  await admin.query(
    "insert into hive.run_events (org_id, run_id, attempt, seq, type, data) values ($1, $2, 1, 1, 'skill_proposal_report', $3)",
    [w.org.orgId, runId, JSON.stringify(report)],
  );
}

const sys = <T>(w: World, fn: (tx: Tx) => Promise<T>) => withTenant(pool, { orgId: w.org.orgId }, fn);
const as = <T>(w: World, who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(pool, { userId: w.org.user(who), orgId: w.org.orgId }, fn);
const batches = (w: World) =>
  sys(w, (tx) => tx.select().from(skillLearningBatches).orderBy(skillLearningBatches.createdAt));
const proposalsOf = (w: World) => sys(w, (tx) => tx.select().from(learnedSkillProposals));

const draft = (over: Partial<SkillProposalSubmitInput["proposals"][number]> = {}) => ({
  kind: "new" as const,
  name: "lam-tron-tien",
  description: "Dùng khi tính tiền: làm tròn theo đơn vị nhỏ nhất của loại tiền, không dùng số thực.",
  content: "## Khi nào dùng\nTính tiền, chia hoá đơn.\n\n- Lưu số nguyên đơn vị nhỏ nhất.",
  reason: "Task T-1 thử lại 3 lần vì làm tròn số thực.",
  ...over,
});

/** Lên lô, giả lập agent nộp `proposals`, nhận kết quả. */
async function learn(w: World, proposals: SkillProposalSubmitInput["proposals"]) {
  const plan = await planSkillLearning(w.deps, w.org.orgId);
  const [batch] = (await batches(w)).filter((b) => b.status === "running");
  if (!batch?.runId) return { plan, created: 0 };
  await finishAgent(w, batch.runId, { proposals });
  return { plan, created: await ingestSkillLearning(w.deps, w.org.orgId) };
}

describe("chọn run đáng học", () => {
  it("thử lại ≥ 2 lần thì chọn; chạy một lần êm thì không", async () => {
    const w = await world();
    await seedRun(w); // một lần, rẻ
    const retried = await seedRetriedTask(w);
    const plan = await planSkillLearning(w.deps, w.org.orgId);
    expect(plan).toEqual({ started: 1, empty: 0, waiting: 0 });
    const [batch] = await batches(w);
    expect(Object.keys(batch?.candidates ?? {})).toEqual([retried.runId]);
    expect(batch?.candidates[retried.runId]).toEqual(["retries"]);
    // Lời nhắc có tóm tắt run (mục tiêu, lỗi) chứ không phải transcript.
    expect(w.created[0]).toContain("Sửa lỗi làm tròn tiền");
    expect(w.created[0]).toContain("Test lỗi: làm tròn sai");
  });

  it("một lần chạy nhưng task chỉ thử lại 1 lần thì chưa đủ", async () => {
    const w = await world();
    await seedRetriedTask(w, 1);
    expect(await planSkillLearning(w.deps, w.org.orgId)).toEqual({ started: 0, empty: 1, waiting: 0 });
  });

  it("chi phí vượt p90 của dự án thì chọn; dưới 10 mẫu thì không so", async () => {
    const few = await world();
    await seedRun(few, { costUsd: 9 });
    expect((await planSkillLearning(few.deps, few.org.orgId)).empty).toBe(1);

    const w = await world();
    for (let i = 0; i < 12; i++) await seedRun(w, { costUsd: 0.1 });
    const pricey = await seedRun(w, { costUsd: 5 });
    await planSkillLearning(w.deps, w.org.orgId);
    const [batch] = await batches(w);
    expect(batch?.candidates).toEqual({ [pricey.runId]: ["cost"] });
  });

  it("run không báo USD so theo token", async () => {
    const w = await world();
    for (let i = 0; i < 12; i++) await seedRun(w, { costUsd: null, tokens: 1000 });
    const big = await seedRun(w, { costUsd: null, tokens: 90_000 });
    await planSkillLearning(w.deps, w.org.orgId);
    expect((await batches(w))[0]?.candidates).toEqual({ [big.runId]: ["cost"] });
  });

  it("người trong đội đánh dấu thì chọn dù run êm; viewer không đánh dấu được; run ngoài đội không thấy", async () => {
    const w = await world();
    const r = await seedRun(w);
    await expect(
      as(w, "tviewer", (tx) => markRunForLearning(tx, w.org.user("tviewer"), { runId: r.runId })),
    ).rejects.toMatchObject({ code: "TEAM_ROLE_REQUIRED" });
    await expect(
      as(w, "oadmin", (tx) => markRunForLearning(tx, w.org.user("oadmin"), { runId: r.runId })),
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    await as(w, "tmember", (tx) => markRunForLearning(tx, w.org.user("tmember"), { runId: r.runId, note: "bẫy tiền" }));
    await planSkillLearning(w.deps, w.org.orgId);
    expect((await batches(w))[0]?.candidates).toEqual({ [r.runId]: ["marked"] });
  });
});

describe("lô theo ngày", () => {
  it("chạy lại trong ngày không tạo thêm run; ngày sau không xét lại run đã vào lô", async () => {
    const w = await world();
    await seedRetriedTask(w);
    expect((await planSkillLearning(w.deps, w.org.orgId)).started).toBe(1);
    expect(await planSkillLearning(w.deps, w.org.orgId)).toEqual({ started: 0, empty: 0, waiting: 0 });
    expect(w.created).toHaveLength(1);

    w.now.value = new Date(w.now.value.getTime() + 24 * 3_600_000);
    // Lô hôm qua chưa xong: vẫn không xét lại, và dự án chưa có run mới nên lô hôm nay rỗng.
    expect(await planSkillLearning(w.deps, w.org.orgId)).toMatchObject({ started: 0 });
    expect(w.created).toHaveLength(1);
  });

  it("không chọn lại run của lô trước dù lô đó đã xong", async () => {
    const w = await world();
    await seedRetriedTask(w);
    await learn(w, []);
    w.now.value = new Date(w.now.value.getTime() + 24 * 3_600_000);
    const plan = await planSkillLearning(w.deps, w.org.orgId);
    expect(plan.started).toBe(0);
    expect(w.created).toHaveLength(1);
  });

  it("không có máy thì không ghi lô, lần hẹn giờ sau thử lại", async () => {
    const w = await world();
    await seedRetriedTask(w);
    w.machine.online = false;
    expect(await planSkillLearning(w.deps, w.org.orgId)).toEqual({ started: 0, empty: 0, waiting: 1 });
    expect(await batches(w)).toHaveLength(0);
    w.machine.online = true;
    expect((await planSkillLearning(w.deps, w.org.orgId)).started).toBe(1);
  });

  it("tổ chức tắt tính năng thì không lô nào, kể cả khi có run đáng học", async () => {
    const w = await world({ enabled: false });
    await seedRetriedTask(w);
    expect(await planSkillLearning(w.deps, w.org.orgId)).toEqual({ started: 0, empty: 0, waiting: 0 });
    expect(await batches(w)).toHaveLength(0);
  });

  it("job hẹn giờ chỉ đi qua tổ chức bật tính năng hoặc còn lô chạy", async () => {
    const on = await world();
    const off = await world({ enabled: false });
    await seedRetriedTask(on);
    await seedRetriedTask(off);
    await runSkillLearningTick(on.deps);
    expect(await batches(on)).toHaveLength(1);
    expect(await batches(off)).toHaveLength(0);
  });

  it("lô rỗng được ghi để ngày sau không xét lại, không tốn run agent", async () => {
    const w = await world();
    await seedRun(w);
    expect(await planSkillLearning(w.deps, w.org.orgId)).toEqual({ started: 0, empty: 1, waiting: 0 });
    expect((await batches(w))[0]).toMatchObject({ status: "empty", runId: null });
    expect(w.created).toHaveLength(0);
  });

  it("run agent lỗi thì lô thất bại, không có đề xuất", async () => {
    const w = await world();
    await seedRetriedTask(w);
    await planSkillLearning(w.deps, w.org.orgId);
    const [batch] = await batches(w);
    await admin.query("update hive.runs set state = 'failed', finished_at = now() where id = $1", [batch?.runId]);
    expect(await ingestSkillLearning(w.deps, w.org.orgId)).toBe(0);
    expect((await batches(w))[0]).toMatchObject({ status: "failed" });
  });
});

describe("nhận đề xuất", () => {
  it("lưu đề xuất chờ duyệt kèm run nguồn và lý do đáng học", async () => {
    const w = await world();
    const t = await seedRetriedTask(w);
    const { created } = await learn(w, [draft()]);
    expect(created).toBe(1);
    const [p] = await proposalsOf(w);
    expect(p).toMatchObject({ name: "lam-tron-tien", kind: "new", status: "pending", baseVersion: 0 });
    expect(p?.sourceRunIds).toEqual([t.runId]);
    expect(p?.triggers).toEqual(["retries"]);
    expect(p?.scopeProjectId).toBe(w.projectId);
    expect((await batches(w))[0]).toMatchObject({ status: "done", accepted: 1, duplicates: 0 });
  });

  it("vượt hạn mức ngày thì bỏ phần dư và không lên lô mới", async () => {
    const w = await world({ maxPerDay: 1 });
    await seedRetriedTask(w);
    const { created } = await learn(w, [
      draft(),
      draft({ name: "chia-hoa-don", description: "Chia hoá đơn theo tỉ lệ nhóm khách, tổng không lệch một đồng." }),
    ]);
    expect(created).toBe(1);
    expect((await batches(w))[0]).toMatchObject({ accepted: 1, duplicates: 1 });
    expect((await batches(w))[0]?.note).toContain("vượt hạn mức");

    await seedRetriedTask(w);
    w.now.value = new Date(w.now.value.getTime() + 60_000);
    // Hết hạn mức: ngày này không giao thêm run, kể cả với dự án có việc đáng học mới.
    await admin.query("update hive.skill_learning_batches set day = '2000-01-01' where org_id = $1", [w.org.orgId]);
    expect((await planSkillLearning(w.deps, w.org.orgId)).started).toBe(0);
    expect(w.created).toHaveLength(1);
  });

  it("lô đang chạy giữ trước hạn mức: không giao thêm run khi chỗ đã hết", async () => {
    const w = await world({ maxPerDay: 1 });
    await seedRetriedTask(w);
    await planSkillLearning(w.deps, w.org.orgId);
    const second = await seedProject(admin, pool, {
      orgId: w.org.orgId,
      teamId: w.org.teamId,
      systemId: w.org.systemId,
      adminUserId: w.org.user("admin"),
      masterKey,
      key: `${w.projectKey}b`,
    });
    const w2 = { ...w, projectId: second.projectId };
    await seedRetriedTask(w2);
    expect((await planSkillLearning(w.deps, w.org.orgId)).started).toBe(0);
  });

  it("tắt tính năng giữa chừng thì đề xuất nộp muộn bị bỏ", async () => {
    const w = await world();
    await seedRetriedTask(w);
    await planSkillLearning(w.deps, w.org.orgId);
    await admin.query("update hive.agent_policies set policy = $2 where org_id = $1", [
      w.org.orgId,
      JSON.stringify(POLICY({ enabled: false, maxPerDay: 5 })),
    ]);
    const [batch] = await batches(w);
    await finishAgent(w, batch?.runId as string, { proposals: [draft()] });
    expect(await ingestSkillLearning(w.deps, w.org.orgId)).toBe(0);
    expect(await proposalsOf(w)).toHaveLength(0);
  });
});

describe("bỏ trùng", () => {
  it("trùng skill đã có, skill mặc định, memory và đề xuất đã từ chối hoặc đang chờ", async () => {
    const w = await world();
    await sys(w, (tx) =>
      saveSkill(
        tx,
        { kind: "user", userId: w.org.user("admin") },
        {
          scope: { level: "org" },
          name: "xu-ly-loi",
          description: "Cách xử lý lỗi và mã lỗi theo module của dịch vụ",
          content: "x",
          baseVersion: 0,
        },
      ),
    );
    await admin.query(
      `insert into hive.memories (org_id, kind, status, content, author_user_id)
       values ($1, 'gotcha', 'approved', $2, 'seed')`,
      [
        w.org.orgId,
        "Khi migrate cơ sở dữ liệu luôn chạy lệnh db:generate rồi commit file SQL sinh ra trong thư mục migrations",
      ],
    );
    await seedRetriedTask(w);
    const { created } = await learn(w, [
      draft({ name: "xu-ly-loi" }),
      draft({ name: "tang-so-xu-ly-loi", description: "Cách xử lý lỗi và mã lỗi theo module của dịch vụ" }),
      draft({
        name: "migrate-db",
        description: "Khi migrate cơ sở dữ liệu luôn chạy lệnh db:generate rồi commit file SQL sinh ra",
      }),
    ]);
    expect(created).toBe(0);
    const note = (await batches(w))[0]?.note ?? "";
    expect(note).toContain("xu-ly-loi: đã có skill cùng tên");
    expect(note).toContain("tang-so-xu-ly-loi: đã có skill xu-ly-loi");
    expect(note).toContain("migrate-db: đã có trong memory");
    expect((await batches(w))[0]?.duplicates).toBe(3);
  });

  it("đề xuất bị từ chối không quay lại ở lô sau, kể cả khi đổi tên một chút", async () => {
    const w = await world();
    await seedRetriedTask(w);
    await learn(w, [draft()]);
    const [p] = await proposalsOf(w);
    await expect(
      as(w, "tadmin", (tx) => rejectLearnedProposal(tx, w.org.user("tadmin"), { id: p?.id as string, reason: "" })),
    ).rejects.toBeDefined();
    const rejected = await as(w, "tadmin", (tx) =>
      rejectLearnedProposal(tx, w.org.user("tadmin"), { id: p?.id as string, reason: "Quá riêng cho task này" }),
    );
    expect(rejected).toMatchObject({ status: "rejected", decisionNote: "Quá riêng cho task này" });

    w.now.value = new Date(w.now.value.getTime() + 24 * 3_600_000);
    await seedRetriedTask(w);
    // Lời nhắc của lô sau nêu skill đã bị từ chối để agent khỏi tốn token viết lại.
    await planSkillLearning(w.deps, w.org.orgId);
    expect(w.created.at(-1)).toContain("lam-tron-tien");
    const [batch] = (await batches(w)).filter((b) => b.status === "running");
    await finishAgent(w, batch?.runId as string, { proposals: [draft({ name: "lam-tron-so-tien" })] });
    expect(await ingestSkillLearning(w.deps, w.org.orgId)).toBe(0);
    expect((await proposalsOf(w)).filter((x) => x.status === "pending")).toHaveLength(0);
  });

  it("đề xuất sửa phải có skill để sửa và nội dung phải đổi", async () => {
    const w = await world();
    await sys(w, (tx) =>
      saveSkill(
        tx,
        { kind: "user", userId: w.org.user("admin") },
        {
          scope: { level: "org" },
          name: "review-code",
          description: "Đọc diff kỹ trước khi duyệt",
          content: "Đọc từng file.",
          baseVersion: 0,
        },
      ),
    );
    await seedRetriedTask(w);
    const { created } = await learn(w, [
      draft({ kind: "edit", name: "khong-co-skill" }),
      draft({ kind: "edit", name: "review-code", content: "Đọc từng file." }),
      draft({
        kind: "edit",
        name: "review-code",
        description: "Đọc diff và kiểm test",
        content: "Đọc từng file.\n\n- Chạy test trước.",
      }),
    ]);
    expect(created).toBe(1);
    const [p] = await proposalsOf(w);
    expect(p).toMatchObject({
      kind: "edit",
      name: "review-code",
      baseVersion: 1,
      scopeTeamId: null,
      scopeProjectId: null,
    });
  });
});

describe("duyệt", () => {
  async function pending(w: World, over: Partial<ReturnType<typeof draft>> = {}) {
    await seedRetriedTask(w);
    await learn(w, [draft(over)]);
    const p = (await proposalsOf(w)).find((x) => x.name === (over.name ?? "lam-tron-tien"));
    return p as NonNullable<typeof p>;
  }

  it("chưa nối kho Git: lưu thành skill của dự án, đề xuất ghi phiên bản kết quả", async () => {
    const w = await world();
    const p = await pending(w);
    const { proposal, openPr } = await as(w, "tadmin", (tx) =>
      approveLearnedProposal(tx, w.org.user("tadmin"), { id: p.id }),
    );
    expect(openPr).toBe(false);
    expect(proposal).toMatchObject({ status: "approved", delivery: { mode: "saved", version: 1 } });
    const { rows } = await admin.query(
      "select team_id, project_id, current_version from hive.skills where org_id = $1",
      [w.org.orgId],
    );
    expect(rows).toEqual([{ team_id: w.org.teamId, project_id: w.projectId, current_version: 1 }]);
    await expect(
      as(w, "tadmin", (tx) => approveLearnedProposal(tx, w.org.user("tadmin"), { id: p.id })),
    ).rejects.toMatchObject({
      code: "LEARNED_PROPOSAL_DECIDED",
    });
  });

  it("người duyệt nâng skill mới lên cấp đội; lên cấp tổ chức cần quản trị tổ chức", async () => {
    const w = await world();
    const p = await pending(w);
    await expect(
      as(w, "tadmin", (tx) => approveLearnedProposal(tx, w.org.user("tadmin"), { id: p.id, scope: "org" })),
    ).rejects.toMatchObject({ code: "ORG_ROLE_REQUIRED" });
    expect((await proposalsOf(w))[0]?.status).toBe("pending");
    await as(w, "tadmin", (tx) => approveLearnedProposal(tx, w.org.user("tadmin"), { id: p.id, scope: "team" }));
    const team = await admin.query("select team_id, project_id from hive.skills where org_id = $1", [w.org.orgId]);
    expect(team.rows).toEqual([{ team_id: w.org.teamId, project_id: null }]);

    w.now.value = new Date(w.now.value.getTime() + 24 * 3_600_000);
    const q = await pending(w, { name: "chia-hoa-don", description: "Chia hoá đơn theo tỉ lệ nhóm khách hàng." });
    await as(w, "admin", (tx) => approveLearnedProposal(tx, w.org.user("admin"), { id: q.id, scope: "org" }));
    const all = await admin.query("select team_id from hive.skills where org_id = $1 and name = 'chia-hoa-don'", [
      w.org.orgId,
    ]);
    expect(all.rows).toEqual([{ team_id: null }]);
  });

  it("thành viên thường và viewer không duyệt được; đội khác không thấy đề xuất", async () => {
    const w = await world();
    const p = await pending(w);
    for (const who of ["tmember", "tviewer"]) {
      await expect(as(w, who, (tx) => approveLearnedProposal(tx, w.org.user(who), { id: p.id }))).rejects.toMatchObject(
        { code: "TEAM_ROLE_REQUIRED" },
      );
      await expect(
        as(w, who, (tx) => rejectLearnedProposal(tx, w.org.user(who), { id: p.id, reason: "không" })),
      ).rejects.toMatchObject({ code: "TEAM_ROLE_REQUIRED" });
    }
    await expect(
      as(w, "oadmin", (tx) => approveLearnedProposal(tx, w.org.user("oadmin"), { id: p.id })),
    ).rejects.toMatchObject({
      code: "LEARNED_PROPOSAL_NOT_FOUND",
    });
    expect(await as(w, "oadmin", (tx) => listLearnedProposals(tx, w.org.user("oadmin"), {}))).toEqual([]);
    expect(await as(w, "tviewer", (tx) => listLearnedProposals(tx, w.org.user("tviewer"), {}))).toHaveLength(1);
    expect(
      await as(w, "tviewer", (tx) => listLearnedProposals(tx, w.org.user("tviewer"), { status: "approved" })),
    ).toHaveLength(0);
  });

  it("skill đã đổi sau khi agent đề xuất thì CONFLICT và đề xuất vẫn chờ", async () => {
    const w = await world();
    const p = await pending(w);
    await sys(w, (tx) =>
      saveSkill(
        tx,
        { kind: "user", userId: w.org.user("admin") },
        {
          scope: { level: "project", projectId: w.projectId },
          name: "lam-tron-tien",
          description: "Ai đó đã thêm trước",
          content: "x",
          baseVersion: 0,
        },
      ),
    );
    await expect(
      as(w, "tadmin", (tx) => approveLearnedProposal(tx, w.org.user("tadmin"), { id: p.id })),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    expect((await proposalsOf(w))[0]?.status).toBe("pending");
  });

  it("đã nối kho Git: ghi đã duyệt, xếp việc mở PR; job mở PR vào kho với SKILL.md đúng đường dẫn", async () => {
    const w = await world();
    const ref = { owner: "xdev-team", name: "xdev-skills" };
    mem.seedRepo(ref, { files: { "README.md": "# skills\n" } });
    await admin.query(
      `insert into hive.skill_repos (org_id, connection_id, owner, name, branch, webhook_secret_enc, configured_by)
       select $1, id, $2, $3, 'main', 'x', 'seed' from hive.scm_connections where org_id = $1 limit 1`,
      [w.org.orgId, ref.owner, ref.name],
    );
    const p = await pending(w);
    const { proposal, openPr } = await as(w, "tadmin", (tx) =>
      approveLearnedProposal(tx, w.org.user("tadmin"), { id: p.id, note: "Hay" }),
    );
    expect(openPr).toBe(true);
    expect(proposal).toMatchObject({
      status: "approved",
      decisionNote: "Hay",
      delivery: { mode: "pr", prNumber: null },
    });
    // Chưa có skill trong hub: bản gốc là Git, vào hub qua đồng bộ sau khi PR merge.
    expect((await admin.query("select 1 from hive.skills where org_id = $1", [w.org.orgId])).rowCount).toBe(0);

    await deliverLearnedProposal(w.deps, w.org.orgId, p.id);
    const [done] = await proposalsOf(w);
    expect(done?.prNumber).toBeTypeOf("number");
    expect(done?.prUrl).toContain(String(done?.prNumber));
    const branch = `hive/learned-skill-${p.id.slice(0, 8)}`;
    const files = mem.repos.get("xdev-team/xdev-skills")?.branches.get(branch) as Map<string, string>;
    expect(files.get(`projects/${w.projectKey}/lam-tron-tien/SKILL.md`)).toBe(
      `---\nname: ${p.name}\ndescription: ${JSON.stringify(p.description)}\n---\n\n${p.content.trim()}\n`,
    );
    // Gọi lại không mở PR thứ hai.
    const before = mem.repos.get("xdev-team/xdev-skills")?.pulls.length;
    await deliverLearnedProposal(w.deps, w.org.orgId, p.id);
    expect(mem.repos.get("xdev-team/xdev-skills")?.pulls.length).toBe(before);
  });

  it("Git lỗi khi mở PR thì ghi lỗi vào đề xuất và ném lại cho hàng đợi thử lại", async () => {
    const w = await world();
    await admin.query(
      `insert into hive.skill_repos (org_id, connection_id, owner, name, branch, webhook_secret_enc, configured_by)
       select $1, id, 'xdev-team', 'khong-ton-tai', 'main', 'x', 'seed' from hive.scm_connections where org_id = $1 limit 1`,
      [w.org.orgId],
    );
    const p = await pending(w);
    await as(w, "tadmin", (tx) => approveLearnedProposal(tx, w.org.user("tadmin"), { id: p.id }));
    await expect(deliverLearnedProposal(w.deps, w.org.orgId, p.id)).rejects.toBeDefined();
    const [row] = await proposalsOf(w);
    expect(row?.prNumber).toBeNull();
    expect(row?.deliveryError).toBeTruthy();
  });
});

describe("đo", () => {
  it("đếm đề xuất, tỉ lệ duyệt, trùng, chi phí run và hạn mức hôm nay", async () => {
    const w = await world({ maxPerDay: 4 });
    await seedRetriedTask(w);
    await learn(w, [
      draft(),
      draft({ name: "chia-hoa-don", description: "Chia hoá đơn theo tỉ lệ nhóm khách, tổng không lệch một đồng." }),
      draft({ name: "lam-tron-tien" }),
    ]);
    const [a, b] = await proposalsOf(w);
    await as(w, "tadmin", (tx) => approveLearnedProposal(tx, w.org.user("tadmin"), { id: a?.id as string }));
    await as(w, "tadmin", (tx) =>
      rejectLearnedProposal(tx, w.org.user("tadmin"), { id: b?.id as string, reason: "Không cần" }),
    );
    const [batch] = await batches(w);
    await admin.query("update hive.runs set cost_usd = 0.42, tokens_in = 8000, tokens_out = 500 where id = $1", [
      batch?.runId,
    ]);
    const stats = await as(w, "tmember", (tx) =>
      skillLearningStats(tx, w.org.user("tmember"), { days: 7 }, w.now.value),
    );
    expect(stats).toEqual({
      enabled: true,
      days: 7,
      batches: 1,
      candidateRuns: 1,
      proposals: 2,
      pending: 0,
      approved: 1,
      rejected: 1,
      duplicates: 1,
      approvalRate: 0.5,
      costUsd: 0.42,
      tokens: 8500,
      today: { used: 2, limit: 4 },
    });
  });

  it("chưa ai quyết thì tỉ lệ duyệt là null; người ngoài tổ chức không xem được", async () => {
    const w = await world();
    const stats = await as(w, "tmember", (tx) => skillLearningStats(tx, w.org.user("tmember"), {}));
    expect(stats).toMatchObject({ proposals: 0, approvalRate: null, costUsd: null, tokens: 0 });
    await expect(
      withTenant(pool, { userId: "nguoi-la", orgId: w.org.orgId }, (tx) => skillLearningStats(tx, "nguoi-la", {})),
    ).rejects.toMatchObject({ code: "NOT_ORG_MEMBER" });
  });
});

describe("RLS", () => {
  it("tổ chức khác không thấy lô, đề xuất hay dấu của tổ chức này", async () => {
    const w = await world();
    const other = await world();
    const t = await seedRetriedTask(w);
    await learn(w, [draft()]);
    await as(w, "tmember", (tx) => markRunForLearning(tx, w.org.user("tmember"), { runId: t.runId }));
    for (const table of ["skill_learning_batches", "learned_skill_proposals", "skill_learning_marks"]) {
      const { rows } = await withTenant(pool, { orgId: other.org.orgId }, (tx) =>
        tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from hive.${table}`)),
      );
      expect(rows[0]?.n, table).toBe(0);
    }
    for (const table of ["skill_learning_batches", "learned_skill_proposals", "skill_learning_marks"]) {
      const { rows } = await admin.query(
        "select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass",
        [`hive.${table}`],
      );
      expect(rows[0], table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    // Ghi sang tổ chức khác bị chặn.
    const code = await pgCode(() =>
      withTenant(pool, { orgId: other.org.orgId }, (tx) =>
        tx.execute(
          sql`insert into hive.skill_learning_marks (org_id, run_id, marked_by) values (${w.org.orgId}, ${t.runId}, 'x')`,
        ),
      ),
    );
    expect(code).toBe("42501");
  });
});
