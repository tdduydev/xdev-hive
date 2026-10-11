// Hàng merge: vào hàng, quyền, xử lý tuần tự với GitProvider trong bộ nhớ, run chế độ auto tự vào hàng, RLS.
import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, type ProjectSettings } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, pgCode, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import {
  enqueueMerge,
  enqueueMergeAs,
  listQueue,
  type MergeDeps,
  processMergeQueue,
  queueForUser,
  removeMergeAs,
} from "./modules/catalog/index.ts";
import { mergeQueueEntries } from "./modules/catalog/schema.ts";
import { createChannel } from "./modules/notify/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";
import { createRunsEngine } from "./modules/runs/index.ts";
import { createMemoryProvider, GitProviderError, type MemoryProvider } from "./modules/scm/index.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const publicUrl = "https://hive.example.com";
const tag = randomUUID().slice(0, 6);

type Org = OrgFixture & { user: (n: string) => string };
let org: Org;
let other: Org;
let provider: MemoryProvider;
let now: Date | null = null;
const deps: MergeDeps = {
  pool: app,
  masterKey,
  providerFactory: () => provider,
  publicUrl,
  now: () => now ?? new Date(),
};

beforeAll(async () => {
  org = await seedOrg(admin, `mq-${tag}`);
  other = await seedOrg(admin, `mq-o-${tag}`);
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
  await withTenant(app, { userId: org.user("admin"), orgId: org.orgId }, (tx) =>
    createChannel(tx, masterKey, org.user("admin"), {
      name: `merge-${tag}`,
      events: ["merge.failed"],
      config: { kind: "telegram", botToken: "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789", chatId: "-1" },
    }),
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

beforeEach(() => {
  now = null;
});

// ---- Công cụ ------------------------------------------------------------------------------------------------

function settings(merge: Partial<ProjectSettings["merge"]> = {}, mergeQueue = true): ProjectSettings {
  const s = defaultProjectSettings();
  return { ...s, merge: { ...s.merge, ...merge }, features: { ...s.features, mergeQueue } };
}

let seq = 0;
interface P {
  projectId: string;
  key: string;
  ref: { owner: string; name: string };
  orgId: string;
}

async function newProject(s: ProjectSettings = settings(), o: Org = org): Promise<P> {
  seq += 1;
  const key = `mq${seq}-${tag}`;
  const p = await seedProject(admin, app, {
    orgId: o.orgId,
    teamId: o.teamId,
    systemId: o.systemId,
    adminUserId: o.user("admin"),
    masterKey,
    key,
    settings: s,
  });
  const ref = { owner: p.owner, name: p.repo };
  provider.seedRepo(ref);
  return { projectId: p.projectId, key, ref, orgId: o.orgId };
}

async function openPR(p: P, head: string): Promise<number> {
  await provider.commitFiles(p.ref, {
    branch: head,
    fromBranch: "main",
    message: head,
    files: [{ path: `${head}.txt`, content: head }],
  });
  return (await provider.openPR(p.ref, { head, base: "main", title: head, body: "" })).number;
}

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const system = <T>(p: P, fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: p.orgId }, fn);
const enqueue = (p: P, prNumber: number, who = "tmember") =>
  as(who, (tx) => enqueueMergeAs(tx, {}, org.user(who), { projectId: p.projectId, prNumber }));
const step = (p: P) => processMergeQueue(deps, { orgId: p.orgId, projectId: p.projectId });
const queue = (p: P) => system(p, (tx) => listQueue(tx, p.projectId));
const entry = async (p: P, prNumber: number) =>
  (await queue(p)).find((e) => e.prNumber === prNumber) ?? expect.fail(`không có mục PR #${prNumber}`);
const calls = (method: string) => provider.calls.filter((c) => c.method === method);
const notes = async (p: P) =>
  (
    await admin.query(
      "select event, title, body, link from hive.notifications where org_id = $1 and title like $2 order by created_at",
      [p.orgId, `%${p.key}%`],
    )
  ).rows as Array<{ event: string; title: string; body: string; link: string | null }>;

// ---- Kịch bản -----------------------------------------------------------------------------------------------

describe("vào hàng và bỏ khỏi hàng", () => {
  it("thành viên đội đưa PR vào hàng; vào lại cùng PR trả mục cũ; người xem chỉ xem được", async () => {
    const p = await newProject();
    const n = await openPR(p, "ai/vao-1");
    const e = await enqueue(p, n);
    expect(e).toMatchObject({
      projectId: p.projectId,
      prNumber: n,
      state: "queued",
      position: 1,
      prUrl: null,
      ciState: null,
      enqueuedBy: org.user("tmember"),
    });
    expect((await enqueue(p, n, "tadmin")).id).toBe(e.id);
    expect(await queue(p)).toHaveLength(1);

    expect(await errorCode(() => enqueue(p, 99, "tviewer"))).toBe("TEAM_ROLE_REQUIRED");
    // Người ngoài đội không biết dự án có tồn tại.
    expect(await errorCode(() => enqueue(p, 99, "oadmin"))).toBe("PROJECT_NOT_FOUND");
    const seen = await as("tviewer", (tx) => queueForUser(tx, org.user("tviewer"), p.projectId));
    expect(seen.map((x) => x.id)).toEqual([e.id]);
    expect(
      await errorCode(() =>
        as("tviewer", (tx) => removeMergeAs(tx, {}, org.user("tviewer"), { projectId: p.projectId, entryId: e.id })),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");
    const audit = await admin.query(
      "select action, actor_user_id from hive.audit_log where target_id = $1 and action like 'merge_queue.%'",
      [p.projectId],
    );
    expect(audit.rows).toEqual([{ action: "merge_queue.enqueue", actor_user_id: org.user("tmember") }]);
  });

  it("dự án tắt merge queue thì không vào hàng được", async () => {
    const p = await newProject(settings({}, false));
    expect(await errorCode(() => enqueue(p, 1))).toBe("MERGE_QUEUE_DISABLED");
  });

  it("bỏ mục đang chờ được, mục đang merge thì không; bỏ rồi vào lại thành mục mới", async () => {
    const p = await newProject();
    const n = await openPR(p, "ai/bo-1");
    const e = await enqueue(p, n);
    const remove = (id: string) =>
      as("tmember", (tx) => removeMergeAs(tx, {}, org.user("tmember"), { projectId: p.projectId, entryId: id }));
    await admin.query("update hive.merge_queue_entries set state = 'merging' where id = $1", [e.id]);
    expect(await errorCode(() => remove(e.id))).toBe("MERGE_IN_PROGRESS");
    await admin.query("update hive.merge_queue_entries set state = 'waiting' where id = $1", [e.id]);
    expect(await remove(e.id)).toMatchObject({ state: "removed", position: null });
    expect(await errorCode(() => remove(e.id))).toBe("MERGE_ENTRY_FINISHED");
    expect(await errorCode(() => remove(randomUUID()))).toBe("MERGE_ENTRY_NOT_FOUND");

    const again = await enqueue(p, n);
    expect(again.id).not.toBe(e.id);
    expect((await queue(p)).map((x) => [x.state, x.position])).toEqual([
      ["queued", 1],
      ["removed", null],
    ]);
    // Mục đã bỏ không được xử lý; hàng chỉ còn mục mới.
    expect(await step(p)).toBe("next");
    expect(await entry(p, n)).toMatchObject({ id: again.id, state: "merged" });
  });
});

describe("xử lý hàng", () => {
  it("FIFO: hai PR merge lần lượt, điền URL, nhánh, sha từ PR", async () => {
    const p = await newProject();
    const a = await openPR(p, "ai/fifo-a");
    const b = await openPR(p, "ai/fifo-b");
    await enqueue(p, a);
    await enqueue(p, b);
    const before = calls("mergePR").length;

    expect(await step(p)).toBe("next");
    const first = await queue(p);
    expect(first.map((x) => [x.prNumber, x.state, x.position])).toEqual([
      [b, "queued", 1],
      [a, "merged", null],
    ]);
    const merged = first[1];
    const pull = provider.repos.get(`${p.ref.owner}/${p.ref.name}`.toLowerCase())?.pulls.find((x) => x.number === a);
    expect(merged).toMatchObject({
      prUrl: pull?.url,
      branch: "ai/fifo-a",
      headSha: pull?.headSha,
      mergeSha: pull?.merged?.sha,
      note: null,
    });
    expect(merged?.finishedAt).not.toBeNull();
    // Mặc định squash, merge đúng sha đã đọc.
    expect(pull?.merged?.method).toBe("squash");

    expect(await step(p)).toBe("next");
    expect(await step(p)).toBe("idle");
    expect(
      calls("mergePR")
        .slice(before)
        .map((c) => c.args[1]),
    ).toEqual([a, b]);
    expect((await queue(p)).every((x) => x.state === "merged")).toBe(true);
    const audit = await admin.query(
      "select count(*)::int as n from hive.audit_log where target_id = $1 and action = 'merge_queue.merged'",
      [p.projectId],
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it("nhánh chính đã tiến (behind): cập nhật nhánh PR rồi merge trên sha mới, theo cách merge của dự án", async () => {
    const p = await newProject(settings({ method: "rebase" }));
    const n = await openPR(p, "ai/behind");
    const old = provider.setPull(p.ref, n, { mergeable: "behind" }).headSha;
    await enqueue(p, n);
    expect(await step(p)).toBe("wait");
    expect(await entry(p, n)).toMatchObject({ state: "updating", headSha: old });
    expect(calls("updatePRBranch").at(-1)?.args).toEqual([p.ref, n, old]);
    const fresh = provider.setPull(p.ref, n, {}).headSha;
    expect(fresh).not.toBe(old);

    expect(await step(p)).toBe("next");
    expect(await entry(p, n)).toMatchObject({ state: "merged", headSha: fresh });
    expect(calls("mergePR").at(-1)?.args[2]).toEqual({ method: "rebase", sha: fresh });
  });

  it("CI đang chạy → waiting, CI xanh → merged; bắt buộc CI mà chưa có CI thì chờ", async () => {
    const p = await newProject(settings({ requireCi: true }));
    const n = await openPR(p, "ai/ci");
    const sha = provider.setPull(p.ref, n, {}).headSha;
    await enqueue(p, n);
    expect(await step(p)).toBe("wait");
    expect(await entry(p, n)).toMatchObject({
      state: "waiting",
      ciState: "none",
      note: expect.stringContaining("Chờ CI"),
    });
    provider.setChecks(p.ref, sha, "pending");
    expect(await step(p)).toBe("wait");
    expect(await entry(p, n)).toMatchObject({ state: "waiting", ciState: "pending", note: "Chờ CI." });
    const since = (await admin.query("select waiting_since from hive.merge_queue_entries where pr_number = $1", [n]))
      .rows;
    expect(since.some((r) => r.waiting_since !== null)).toBe(true);
    provider.setChecks(p.ref, sha, "success");
    expect(await step(p)).toBe("next");
    expect(await entry(p, n)).toMatchObject({ state: "merged", ciState: "success" });
  });

  it("CI đỏ → failed, có thông báo merge.failed kèm link PR; hàng đi tiếp", async () => {
    const p = await newProject();
    const red = await openPR(p, "ai/ci-do");
    const ok = await openPR(p, "ai/ci-xanh");
    provider.setChecks(p.ref, provider.setPull(p.ref, red, {}).headSha, "failure");
    await enqueue(p, red);
    await enqueue(p, ok);
    expect(await step(p)).toBe("next");
    const failed = await entry(p, red);
    expect(failed).toMatchObject({ state: "failed", ciState: "failure", note: "CI không đạt.", position: null });
    const [note] = await notes(p);
    expect(note).toMatchObject({
      event: "merge.failed",
      title: `Không merge được PR #${red} của ${p.key}`,
      link: failed.prUrl,
    });
    expect(note?.body).toContain("CI không đạt.");
    const { rows: inbox } = await admin.query(
      "select user_id, event, link from hive.inbox_items where org_id = $1 and event_key = $2",
      [p.orgId, failed.id],
    );
    expect(inbox).toEqual([{ user_id: org.user("tmember"), event: "merge.failed", link: failed.prUrl }]);
    expect(await step(p)).toBe("next");
    expect(await entry(p, ok)).toMatchObject({ state: "merged" });
  });

  it("clears the CI snapshot when a new head is waiting for a branch update", async () => {
    const p = await newProject(settings({ requireCi: true }));
    const n = await openPR(p, "ai/ci-snapshot");
    const oldSha = provider.setPull(p.ref, n, {}).headSha;
    provider.setChecks(p.ref, oldSha, "pending");
    await enqueue(p, n);
    expect(await step(p)).toBe("wait");
    expect(await entry(p, n)).toMatchObject({ ciState: "pending", headSha: oldSha });

    provider.setPull(p.ref, n, { headSha: "updated-head", mergeable: "behind" });
    expect(await step(p)).toBe("wait");
    expect(await entry(p, n)).toMatchObject({ state: "updating", ciState: null, headSha: "updated-head" });
    const fresh = provider.setPull(p.ref, n, {}).headSha;
    provider.setChecks(p.ref, fresh, "success");
    expect(await step(p)).toBe("next");
    expect(await entry(p, n)).toMatchObject({ state: "merged", ciState: "success", headSha: fresh });
  });

  it("xung đột với nhánh chính → failed", async () => {
    const p = await newProject();
    const n = await openPR(p, "ai/xung-dot");
    provider.setPull(p.ref, n, { mergeable: "conflict" });
    await enqueue(p, n);
    expect(await step(p)).toBe("next");
    expect(await entry(p, n)).toMatchObject({ state: "failed", note: "PR xung đột với nhánh chính." });
    expect((await notes(p)).map((x) => x.event)).toEqual(["merge.failed"]);
  });

  it("PR bị merge tay ngoài Hive → merged, không gọi merge; PR đóng → failed", async () => {
    const p = await newProject();
    const tay = await openPR(p, "ai/merge-tay");
    const dong = await openPR(p, "ai/dong");
    provider.setPull(p.ref, tay, { state: "merged" });
    provider.setPull(p.ref, dong, { state: "closed" });
    await enqueue(p, tay);
    await enqueue(p, dong);
    const before = calls("mergePR").length;
    expect(await step(p)).toBe("next");
    expect(await entry(p, tay)).toMatchObject({
      state: "merged",
      mergeSha: null,
      note: "PR đã được merge ngoài hàng.",
    });
    expect(await step(p)).toBe("next");
    expect(await entry(p, dong)).toMatchObject({ state: "failed", note: "PR đã bị đóng." });
    expect(calls("mergePR").length).toBe(before);
  });

  it("bản nháp, chờ người duyệt, nhà cung cấp đang tính → waiting; PR nhắm nhánh khác, không có PR → failed", async () => {
    const p = await newProject();
    const n = await openPR(p, "ai/cho");
    await enqueue(p, n);
    provider.setPull(p.ref, n, { draft: true });
    expect(await step(p)).toBe("wait");
    expect(await entry(p, n)).toMatchObject({ state: "waiting", note: "PR đang là bản nháp." });
    provider.setPull(p.ref, n, { draft: false, mergeable: "unknown" });
    expect(await step(p)).toBe("wait");
    expect((await entry(p, n)).note).toContain("tính trạng thái merge");
    provider.setPull(p.ref, n, { mergeable: "blocked" });
    expect(await step(p)).toBe("wait");
    expect(await entry(p, n)).toMatchObject({ state: "waiting", note: "Chờ người duyệt hoặc kiểm tra bắt buộc." });
    provider.setPull(p.ref, n, { base: "develop", mergeable: "clean" });
    expect(await step(p)).toBe("next");
    expect((await entry(p, n)).note).toContain("develop");

    await enqueue(p, 4242);
    expect(await step(p)).toBe("next");
    expect(await entry(p, 4242)).toMatchObject({ state: "failed", note: "Không tìm thấy PR #4242." });
  });

  it("nhà cung cấp từ chối merge (PR vừa đổi) → về hàng, lần sau merge được; quá số lần thì failed", async () => {
    const p = await newProject();
    const n = await openPR(p, "ai/tu-choi");
    await enqueue(p, n);
    provider.fail("mergePR", new GitProviderError("conflict", "GitLab: head đã đổi", { status: 409 }));
    expect(await step(p)).toBe("wait");
    const back = await entry(p, n);
    expect(back).toMatchObject({ state: "queued", position: 1 });
    expect(back.note).toContain("sẽ thử lại");
    expect(
      (await admin.query("select attempts from hive.merge_queue_entries where id = $1", [back.id])).rows[0],
    ).toEqual({ attempts: 1 });
    provider.fail("mergePR", null);
    expect(await step(p)).toBe("next");
    expect(await entry(p, n)).toMatchObject({ state: "merged" });

    const m = await openPR(p, "ai/tu-choi-mai");
    const e = await enqueue(p, m);
    await admin.query("update hive.merge_queue_entries set attempts = 4 where id = $1", [e.id]);
    provider.fail("mergePR", new GitProviderError("conflict", "GitLab: không merge được", { status: 405 }));
    try {
      expect(await step(p)).toBe("next");
    } finally {
      provider.fail("mergePR", null);
    }
    expect(await entry(p, m)).toMatchObject({ state: "failed", note: expect.stringContaining("5 lần") });
  });

  it("lỗi tạm thời của nhà cung cấp giữ nguyên mục, hỏi lại sau", async () => {
    const p = await newProject();
    const n = await openPR(p, "ai/tam-thoi");
    await enqueue(p, n);
    provider.fail("getPR", new GitProviderError("rate_limited", "GitLab: hết hạn mức", { status: 429 }));
    try {
      expect(await step(p)).toBe("wait");
    } finally {
      provider.fail("getPR", null);
    }
    expect(await entry(p, n)).toMatchObject({ state: "queued" });
  });

  it("chờ quá 24 giờ → failed", async () => {
    const p = await newProject();
    const n = await openPR(p, "ai/qua-han");
    provider.setPull(p.ref, n, { mergeable: "blocked" });
    await enqueue(p, n);
    expect(await step(p)).toBe("wait");
    now = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(await step(p)).toBe("next");
    expect(await entry(p, n)).toMatchObject({ state: "failed", note: expect.stringMatching(/^Chờ quá 24 giờ/) });
  });

  it("tắt tính năng thì hàng dừng, mục giữ nguyên", async () => {
    const p = await newProject();
    const n = await openPR(p, "ai/tat");
    await enqueue(p, n);
    await admin.query(
      "update hive.projects set settings = jsonb_set(settings, '{features,mergeQueue}', 'false') where id = $1",
      [p.projectId],
    );
    expect(await step(p)).toBe("idle");
    expect(await entry(p, n)).toMatchObject({ state: "queued" });
  });
});

describe("run chế độ auto", () => {
  /** Seed run đang verifying kèm kết quả của worker, rồi cho lõi run chạy verifying như khi nhận run_result. */
  async function verifyRun(p: P, branch: string) {
    await provider.commitFiles(p.ref, {
      branch,
      fromBranch: "main",
      message: branch,
      files: [{ path: "a.txt", content: branch }],
    });
    const one = async (q: string, params: unknown[]) => (await admin.query(q, params)).rows[0].id as string;
    const number = Number((await admin.query("select count(*)::int + 1 as n from hive.tasks")).rows[0].n);
    const taskId = await one(
      `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by, status)
       values ($1, $2, $3, $4, $5, 'Việc tự merge', $6, 'running') returning id`,
      [org.orgId, org.teamId, p.projectId, number, `${p.key}-${number}`, org.user("tmember")],
    );
    const runId = await one(
      `insert into hive.runs (org_id, team_id, task_id, project_id, branch, policy_snapshot, created_by, state)
       values ($1, $2, $3, $4, $5, '[{"check":"changes","required":true}]', $6, 'verifying') returning id`,
      [org.orgId, org.teamId, taskId, p.projectId, branch, org.user("tmember")],
    );
    await admin.query(
      `insert into hive.run_events (org_id, run_id, attempt, seq, type, data) values ($1, $2, 1, 1, 'result', $3)`,
      [org.orgId, runId, JSON.stringify({ exit: 0, headSha: "c".repeat(40), report: { commitCount: 1 } })],
    );
    const engine = createRunsEngine({
      pool: app,
      publicUrl,
      authSecret: "test-secret-0123456789abcdef-0123456789",
      masterKey,
      providerFactory: () => provider,
      logger: { warn: () => {}, error: () => {} },
    });
    try {
      await engine.fire({ kind: "verify", orgId: org.orgId, runId });
    } finally {
      engine.stop();
    }
    const run = (await admin.query("select state, pr_url from hive.runs where id = $1", [runId])).rows[0];
    return { runId, taskId, run };
  }

  it("run đạt có PR vào thẳng hàng merge; chế độ review thì không", async () => {
    const auto = await newProject(settings({ mode: "auto" }));
    const { runId, taskId, run } = await verifyRun(auto, "ai/auto-1");
    expect(run.state).toBe("succeeded");
    const [e] = await queue(auto);
    expect(e).toMatchObject({
      state: "queued",
      prUrl: run.pr_url,
      branch: "ai/auto-1",
      runId,
      taskId,
      enqueuedBy: org.user("tmember"),
    });
    expect(await step(auto)).toBe("next");
    expect(await entry(auto, e?.prNumber ?? 0)).toMatchObject({ state: "merged" });

    const review = await newProject(settings({ mode: "review" }));
    expect((await verifyRun(review, "ai/review-1")).run.state).toBe("succeeded");
    expect(await queue(review)).toEqual([]);
  });
});

describe("RLS bảng merge_queue_entries", () => {
  it("không có context thì 0 dòng; tổ chức khác không thấy, không ghi được", async () => {
    const mine = await newProject();
    const theirs = await newProject(settings(), other);
    const n = await openPR(mine, "ai/rls");
    await enqueue(mine, n);
    await withTenant(app, { orgId: other.orgId }, (tx) =>
      enqueueMerge(tx, { projectId: theirs.projectId, prNumber: 1, by: other.user("tmember") }),
    );

    await withTenant(app, {}, async (tx) => {
      expect(await tx.select().from(mergeQueueEntries)).toHaveLength(0);
    });
    await withTenant(app, { orgId: org.orgId }, async (tx) => {
      const rows = await tx.select().from(mergeQueueEntries);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.orgId === org.orgId)).toBe(true);
    });
    const inMine = (fn: (tx: Tx) => Promise<unknown>) => pgCode(() => withTenant(app, { orgId: org.orgId }, fn));
    const row = { prNumber: 7, enqueuedBy: "x" };
    expect(
      await inMine((tx) =>
        tx.insert(mergeQueueEntries).values({ ...row, orgId: other.orgId, projectId: theirs.projectId }),
      ),
    ).toBe("42501");
    // Ghi org của mình nhưng trỏ tới dự án của tổ chức khác: khoá kép chặn.
    expect(
      await inMine((tx) =>
        tx.insert(mergeQueueEntries).values({ ...row, orgId: org.orgId, projectId: theirs.projectId }),
      ),
    ).toBe("23503");
    expect(
      await inMine((tx) =>
        tx.update(mergeQueueEntries).set({ orgId: other.orgId }).where(eq(mergeQueueEntries.projectId, mine.projectId)),
      ),
    ).toBe("42501");
    // Dự án của tổ chức khác không tìm thấy trong context của mình.
    expect(
      await errorCode(() =>
        withTenant(app, { orgId: org.orgId }, (tx) =>
          enqueueMerge(tx, { projectId: theirs.projectId, prNumber: 2, by: "x" }),
        ),
      ),
    ).toBe("PROJECT_NOT_FOUND");
  });

  it("hive_app không TRUNCATE được bảng", async () => {
    await expect(app.query("truncate hive.merge_queue_entries")).rejects.toThrow(/permission denied/);
  });
});
