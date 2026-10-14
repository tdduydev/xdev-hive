// Commit status `xdev-hive/review` theo trạng thái phiên (Q1): pending, failure, success, thả khi huỷ, bỏ qua khi xong.
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, GitProviderError, type MemoryProvider } from "../scm/index.ts";
import { codeReviews } from "./schema.ts";
import {
  deliverReviewStatus,
  prepareReviewStatus,
  publishReviewStatus,
  REVIEW_STATUS_CONTEXT,
  type ReviewStatusDeps,
  reviewStatusOf,
} from "./status.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const sha = (n: number) => n.toString(16).padStart(40, "0");
const PUBLIC_URL = "https://hive.example.com/";

let org: OrgFixture & { user: (n: string) => string };
let provider: MemoryProvider;
const warn = vi.fn();
const deps = (): ReviewStatusDeps => ({
  providerFactory: () => provider,
  masterKey,
  publicUrl: PUBLIC_URL,
  logger: { warn },
});

const sys = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

beforeAll(async () => {
  org = await seedOrg(admin, `crs-${tag}`);
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

let seq = 0;
let pr = 200;
async function newReview(o: { status?: string; headSha?: string; name?: string } = {}) {
  seq += 1;
  pr += 1;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `crs${seq}-${tag}`,
  });
  const ref = { owner: p.owner, name: p.repo };
  const repo = provider.seedRepo(ref);
  const run = await admin.query(
    `insert into hive.runs (org_id, team_id, project_id, branch, policy_snapshot, created_by, state)
     values ($1, $2, $3, $4, '[]', $5, 'succeeded') returning id`,
    [org.orgId, org.teamId, p.projectId, `ai/pr-${pr}`, org.user("tmember")],
  );
  const phases = [
    { name: "Review", gates: [{ id: "rules", name: "Quy tắc", kind: "rule", rules: [], slaHours: null }] },
  ];
  const { rows } = await admin.query(
    `insert into hive.code_reviews (org_id, team_id, project_id, run_id, workflow_name, phases, options, pr_number, pr_url,
       branch, base_branch, head_sha, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'main', $11, $12) returning id`,
    [
      org.orgId,
      org.teamId,
      p.projectId,
      run.rows[0].id,
      o.name ?? "Quy trình thử",
      JSON.stringify(phases),
      JSON.stringify({ merge: "project", maxAgentRevisions: 2, dismissStaleApprovals: false }),
      pr,
      `https://git.example.com/pr/${pr}`,
      `ai/pr-${pr}`,
      o.headSha ?? sha(1),
      o.status ?? "in_review",
    ],
  );
  return { id: rows[0].id as string, ref, repo, headSha: o.headSha ?? sha(1) };
}

const load = (id: string) =>
  sys(async (tx) => {
    const [r] = await tx.select().from(codeReviews).where(eq(codeReviews.id, id));
    if (!r) throw new Error("no review");
    return r;
  });

/** Đặt trạng thái rồi đăng và chờ lời gọi mạng xong, để test đọc được kết quả. */
async function post(id: string, status: string, d: ReviewStatusDeps = deps()) {
  await admin.query("update hive.code_reviews set status = $2 where id = $1", [id, status]);
  const review = await load(id);
  const delivery = await sys((tx) => prepareReviewStatus(tx, review, d));
  if (delivery) await deliverReviewStatus(delivery, d.logger);
  return delivery;
}

const statusOn = (r: { repo: { statuses: Map<string, Map<string, unknown>> } }, headSha: string) =>
  r.repo.statuses.get(headSha)?.get(REVIEW_STATUS_CONTEXT);

describe("reviewStatusOf: trạng thái phiên → status", () => {
  const row = (status: string) => ({ id: "r1", status, workflowName: "Review release" }) as never;
  it("ánh xạ trạng thái, bỏ qua phiên đã xong, link về phiên", () => {
    expect(reviewStatusOf(row("in_review"), PUBLIC_URL)).toMatchObject({
      context: "xdev-hive/review",
      state: "pending",
      targetUrl: "https://hive.example.com/knowledge/reviews?tab=code&id=r1",
    });
    expect(reviewStatusOf(row("changes_requested"))?.state).toBe("failure");
    expect(reviewStatusOf(row("approved"))?.state).toBe("success");
    expect(reviewStatusOf(row("cancelled"))?.state).toBe("success");
    expect(reviewStatusOf(row("merged"))).toBeNull();
    expect(reviewStatusOf(row("superseded"))).toBeNull();
    // Không có publicUrl thì không đặt targetUrl thay vì để chuỗi rỗng.
    expect(reviewStatusOf(row("in_review"))).not.toHaveProperty("targetUrl");
  });

  it("mô tả không quá 140 ký tự dù tên quy trình dài", () => {
    const s = reviewStatusOf({ id: "r1", status: "approved", workflowName: "x".repeat(300) } as never);
    expect(s?.description.length).toBeLessThanOrEqual(140);
  });
});

describe("đặt status lên commit đầu của PR", () => {
  it("in_review → pending, changes_requested → failure, approved → success trên cùng SHA", async () => {
    const r = await newReview({ name: "Review release" });
    await post(r.id, "in_review");
    expect(statusOn(r, r.headSha)).toMatchObject({ state: "pending", targetUrl: expect.stringContaining(r.id) });
    expect((statusOn(r, r.headSha) as { description: string }).description).toContain("Review release");
    await post(r.id, "changes_requested");
    expect(statusOn(r, r.headSha)).toMatchObject({ state: "failure" });
    await post(r.id, "approved");
    expect(statusOn(r, r.headSha)).toMatchObject({ state: "success" });
  });

  it("vòng mới trên SHA mới đặt pending ở SHA mới và giữ nguyên SHA cũ", async () => {
    const r = await newReview({ headSha: sha(10) });
    await post(r.id, "approved");
    await admin.query("update hive.code_reviews set head_sha = $2 where id = $1", [r.id, sha(11)]);
    await post(r.id, "in_review");
    expect(statusOn(r, sha(10))).toMatchObject({ state: "success" });
    expect(statusOn(r, sha(11))).toMatchObject({ state: "pending" });
  });

  it("phiên huỷ thả PR bằng success; merged và superseded không đăng gì", async () => {
    const r = await newReview();
    await post(r.id, "in_review");
    await post(r.id, "cancelled");
    expect(statusOn(r, r.headSha)).toMatchObject({ state: "success" });

    const merged = await newReview();
    expect(await post(merged.id, "merged")).toBeNull();
    const superseded = await newReview();
    expect(await post(superseded.id, "superseded")).toBeNull();
    expect(merged.repo.statuses.size + superseded.repo.statuses.size).toBe(0);
  });
});

describe("lỗi và thiếu cấu hình không làm hỏng người gọi", () => {
  it("nhà cung cấp lỗi chỉ ghi cảnh báo, không ném", async () => {
    const r = await newReview();
    warn.mockClear();
    provider.fail("setCommitStatus", new GitProviderError("unavailable", "GitLab trả 500"));
    try {
      await expect(post(r.id, "in_review")).resolves.toBeDefined();
    } finally {
      provider.fail("setCommitStatus", null);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`PR #${(await load(r.id)).prNumber}`));
    expect(statusOn(r, r.headSha)).toBeUndefined();
  });

  it("không có khoá chủ hoặc nhà cung cấp thì bỏ qua, không gọi mạng", async () => {
    const r = await newReview();
    const before = provider.calls.length;
    expect(await post(r.id, "in_review", { publicUrl: PUBLIC_URL, logger: { warn } })).toBeNull();
    expect(await post(r.id, "in_review", { masterKey, logger: { warn } })).toBeNull();
    expect(provider.calls.length).toBe(before);
  });

  it("publishReviewStatus đặt status ở nền sau khi đọc xong trong transaction", async () => {
    const r = await newReview();
    const review = await load(r.id);
    await sys((tx) => publishReviewStatus(tx, review, deps()));
    await vi.waitFor(() => expect(statusOn(r, r.headSha)).toMatchObject({ state: "pending" }));
  });
});
