import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, withTenant } from "../platform/index.ts";
import { codeReviewComments, codeReviewGateRuns, codeReviews } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

type Org = OrgFixture & { user: (n: string) => string };
const seeded: Record<"a" | "b", { org: Org; reviewId: string; gateRunId: string; commentId: string }> = {} as never;

const review = (orgId: string, teamId: string, over: Partial<typeof codeReviews.$inferInsert> = {}) => ({
  orgId,
  teamId,
  projectId: randomUUID(),
  runId: randomUUID(),
  workflowName: "Review code cơ bản",
  phases: [],
  options: { merge: "project" as const, maxAgentRevisions: 2, dismissStaleApprovals: false },
  prNumber: 7,
  prUrl: "https://git.test/pr/7",
  branch: "ai/k-1",
  baseBranch: "main",
  headSha: "a".repeat(40),
  ...over,
});

async function seed(name: "a" | "b") {
  const org = await seedOrg(admin, `cr-rls-${name}-${randomUUID().slice(0, 6)}`);
  const { rows } = await admin.query(
    `insert into hive.code_reviews (org_id, team_id, project_id, run_id, workflow_name, phases, options, pr_number,
       pr_url, branch, base_branch, head_sha)
     values ($1, $2, $3, $4, 'w', '[]', '{}', 1, 'u', 'b', 'main', 'sha') returning id`,
    [org.orgId, org.teamId, randomUUID(), randomUUID()],
  );
  const gate = await admin.query(
    "insert into hive.code_review_gate_runs (org_id, review_id, gate_index, gate_id, head_sha) values ($1, $2, 0, 'g', 'sha') returning id",
    [org.orgId, rows[0].id],
  );
  const commentId = randomUUID();
  await admin.query(
    `insert into hive.code_review_comments (id, org_id, review_id, thread_id, path, line, side, head_sha, body)
     values ($1, $2, $3, $1, 'a.ts', 1, 'new', 'sha', 'Góp ý')`,
    [commentId, org.orgId, rows[0].id],
  );
  seeded[name] = { org, reviewId: rows[0].id, gateRunId: gate.rows[0].id, commentId };
}

beforeAll(async () => {
  await seed("a");
  await seed("b");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("RLS bảng review code", () => {
  it("không có context thì trả 0 dòng", async () => {
    await withTenant(app, {}, async (tx) => {
      expect(await tx.select().from(codeReviews)).toHaveLength(0);
      expect(await tx.select().from(codeReviewGateRuns)).toHaveLength(0);
      expect(await tx.select().from(codeReviewComments)).toHaveLength(0);
    });
  });

  it("context tổ chức A chỉ thấy dữ liệu của A", async () => {
    await withTenant(app, { orgId: seeded.a.org.orgId }, async (tx) => {
      const reviews = await tx.select().from(codeReviews);
      const gates = await tx.select().from(codeReviewGateRuns);
      const comments = await tx.select().from(codeReviewComments);
      expect(comments.length).toBeGreaterThan(0);
      expect(comments.every((r) => r.orgId === seeded.a.org.orgId)).toBe(true);
      expect(reviews.length).toBeGreaterThan(0);
      expect(gates.length).toBeGreaterThan(0);
      expect(reviews.every((r) => r.orgId === seeded.a.org.orgId)).toBe(true);
      expect(gates.every((r) => r.orgId === seeded.a.org.orgId)).toBe(true);
    });
  });

  it("không ghi được phiên hay lượt checkpoint cho tổ chức khác", async () => {
    const a = seeded.a.org;
    const b = seeded.b;
    const inA = (fn: Parameters<typeof withTenant>[2]) => pgCode(() => withTenant(app, { orgId: a.orgId }, fn));
    expect(await inA((tx) => tx.insert(codeReviews).values(review(b.org.orgId, b.org.teamId)))).toBe("42501");
    expect(
      await inA((tx) =>
        tx
          .insert(codeReviewGateRuns)
          .values({ orgId: b.org.orgId, reviewId: b.reviewId, gateIndex: 0, gateId: "g", headSha: "x" }),
      ),
    ).toBe("42501");
    expect(
      await inA((tx) =>
        tx.update(codeReviews).set({ orgId: b.org.orgId }).where(eq(codeReviews.id, seeded.a.reviewId)),
      ),
    ).toBe("42501");
  });

  it("A không sửa hay xoá được phiên của B", async () => {
    await withTenant(app, { orgId: seeded.a.org.orgId }, async (tx) => {
      const updated = await tx
        .update(codeReviews)
        .set({ status: "cancelled" })
        .where(eq(codeReviews.id, seeded.b.reviewId))
        .returning();
      expect(updated).toHaveLength(0);
      expect(await tx.delete(codeReviewGateRuns).where(eq(codeReviewGateRuns.id, seeded.b.gateRunId))).toHaveProperty(
        "rowCount",
        0,
      );
    });
  });

  it("bình luận chặn ghi chéo tổ chức và liên kết chéo review, luồng", async () => {
    const a = seeded.a;
    const b = seeded.b;
    const inA = (fn: Parameters<typeof withTenant>[2]) => pgCode(() => withTenant(app, { orgId: a.org.orgId }, fn));
    const value = {
      id: randomUUID(),
      orgId: b.org.orgId,
      reviewId: b.reviewId,
      threadId: b.commentId,
      path: "a",
      line: 1,
      side: "new" as const,
      headSha: "sha",
      body: "Góp ý",
    };
    expect(await inA((tx) => tx.insert(codeReviewComments).values(value))).toBe("42501");
    expect(
      await inA((tx) =>
        tx.update(codeReviewComments).set({ orgId: b.org.orgId }).where(eq(codeReviewComments.id, a.commentId)),
      ),
    ).toBe("42501");
    expect(await inA((tx) => tx.insert(codeReviewComments).values({ ...value, orgId: a.org.orgId }))).toBe("23503");
    expect(
      await inA((tx) => tx.insert(codeReviewComments).values({ ...value, orgId: a.org.orgId, reviewId: a.reviewId })),
    ).toBe("23503");
    await withTenant(app, { orgId: a.org.orgId }, async (tx) => {
      expect(
        await tx
          .update(codeReviewComments)
          .set({ body: "Sửa trái phép" })
          .where(eq(codeReviewComments.id, b.commentId))
          .returning(),
      ).toHaveLength(0);
      expect(await tx.delete(codeReviewComments).where(eq(codeReviewComments.id, b.commentId))).toHaveProperty(
        "rowCount",
        0,
      );
    });
  });

  it("cả ba bảng bật và ép RLS", async () => {
    const { rows } = await admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where oid in ('hive.code_reviews'::regclass, 'hive.code_review_gate_runs'::regclass, 'hive.code_review_comments'::regclass)`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it("chỉ một phiên mở cho mỗi PR; vòng cũ superseded thì mở được vòng mới", async () => {
    const { orgId, teamId } = seeded.a.org;
    const projectId = randomUUID();
    const open = (round: number) =>
      withTenant(app, { orgId }, (tx) =>
        tx
          .insert(codeReviews)
          .values(review(orgId, teamId, { projectId, prNumber: 42, round }))
          .returning(),
      );
    const first = (await open(1))[0] as { id: string };
    expect(await pgCode(() => open(2))).toBe("23505");
    await withTenant(app, { orgId }, (tx) =>
      tx.update(codeReviews).set({ status: "superseded" }).where(eq(codeReviews.id, first.id)),
    );
    const second = (await open(2))[0] as { id: string };
    expect(second.id).not.toBe(first.id);
  });

  it("trạng thái phiên và lượt checkpoint ngoài danh sách bị CHECK chặn", async () => {
    const { orgId, teamId } = seeded.a.org;
    expect(
      await pgCode(() =>
        withTenant(app, { orgId }, (tx) =>
          // biome-ignore lint/suspicious/noExplicitAny: cố ý ghi giá trị sai kiểu để thử ràng buộc
          tx.insert(codeReviews).values(review(orgId, teamId, { status: "bogus" as any })),
        ),
      ),
    ).toBe("23514");
    expect(
      await pgCode(() =>
        withTenant(app, { orgId }, (tx) =>
          tx.insert(codeReviewGateRuns).values({
            orgId,
            reviewId: seeded.a.reviewId,
            gateIndex: 1,
            gateId: "g",
            headSha: "x",
            status: "bogus",
          }),
        ),
      ),
    ).toBe("23514");
  });

  it("quy trình có khối code khi và chỉ khi subject = code", async () => {
    const { orgId } = seeded.a.org;
    // SQL thô vì module chỉ được import module khác qua index.ts.
    const insert = (subject: string, code: string | null) =>
      pgCode(() =>
        withTenant(app, { orgId }, (tx) =>
          tx.execute(
            sql`insert into hive.review_workflows (org_id, name, preset, subject, doc_prefixes, phases, code)
                values (${orgId}, 'w', 'custom', ${subject}, '{}', '[]', ${code}::jsonb)`,
          ),
        ),
      );
    expect(await insert("doc", null)).toBeUndefined();
    expect(await insert("code", "{}")).toBeUndefined();
    expect(await insert("code", null)).toBe("23514");
    expect(await insert("doc", "{}")).toBe("23514");
    expect(await insert("other", null)).toBe("23514");
  });

  it("hive.code_review_overdue_orgs chỉ trả tổ chức có checkpoint chờ, quá hạn, chưa nhắc", async () => {
    const overdue = async () =>
      withTenant(app, {}, async (tx) => {
        const res = await tx.execute<{ org_id: string }>(sql`select org_id from hive.code_review_overdue_orgs()`);
        return res.rows.map((r) => r.org_id);
      });
    expect(await overdue()).not.toContain(seeded.a.org.orgId);

    await admin.query("update hive.code_review_gate_runs set due_at = now() - interval '1 hour' where id = $1", [
      seeded.a.gateRunId,
    ]);
    const ids = await overdue();
    expect(ids).toContain(seeded.a.org.orgId);
    expect(ids).not.toContain(seeded.b.org.orgId);

    await admin.query("update hive.code_review_gate_runs set overdue_notified_at = now() where id = $1", [
      seeded.a.gateRunId,
    ]);
    expect(await overdue()).not.toContain(seeded.a.org.orgId);
  });
});
