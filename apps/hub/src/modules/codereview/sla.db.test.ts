// Nhắc hạn checkpoint người duyệt (US7): một thông báo mỗi lượt chờ, phiên đã đi tiếp thì không nhắc.
import { randomBytes, randomUUID } from "node:crypto";
import { workflowInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import { type CodeReviewWorkerDeps, handleCodeReviewJob } from "./jobs.ts";
import { type CodeReviewJob, type CodeReviewRun, startCodeReview } from "./service.ts";
import { remindOverdueCodeReviews } from "./sla.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let provider: MemoryProvider;

const queued: CodeReviewJob[] = [];
const jobs: Jobs = {
  start: async () => {},
  stop: async () => {},
  enqueue: async (_q, data) => {
    queued.push(data as CodeReviewJob);
    return randomUUID();
  },
  schedule: async () => {},
  work: async () => {},
};
const deps: CodeReviewWorkerDeps = {
  pool: app,
  jobs,
  masterKey,
  providerFactory: () => provider,
  publicUrl: "https://hive.example.com",
};
const sla = { pool: app, publicUrl: "https://hive.example.com" };

const sys = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

beforeAll(async () => {
  org = await seedOrg(admin, `crsla-${tag}`);
  provider = createMemoryProvider("gitlab", ["xdev-team"]);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

let seq = 0;
/** Mở phiên có một checkpoint người duyệt (SLA 1 giờ) và chạy tới khi checkpoint đó chờ. */
async function waitingReview(reviewerUsers: string[] = []) {
  seq += 1;
  const key = `sla${seq}-${tag}`;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
  });
  const ref = { owner: p.owner, name: p.repo };
  provider.seedRepo(ref);
  const branch = `ai/sla${seq}`;
  await provider.commitFiles(ref, {
    branch,
    fromBranch: "main",
    message: "agent",
    files: [{ path: "src/a.ts", content: "export {}\n" }],
  });
  const { number, url } = await provider.openPR(ref, { head: branch, base: "main", title: branch, body: "" });
  const pr = await provider.getPR(ref, number);
  const w = workflowInput.parse({
    name: `Duyệt ${seq}`,
    preset: "custom",
    subject: "code",
    teamId: org.teamId,
    docPrefixes: [],
    code: { projects: [key] },
    phases: [
      {
        name: "Review",
        gates: [
          {
            id: "reviewer",
            name: "Người duyệt",
            kind: "human",
            reviewers: { users: reviewerUsers, roles: reviewerUsers.length ? [] : ["team-member"], quorum: 1 },
            slaHours: 1,
          },
        ],
      },
    ],
    enabled: true,
  });
  await admin.query(
    `insert into hive.review_workflows (org_id, team_id, name, preset, subject, doc_prefixes, code, phases, enabled)
     values ($1, $2, $3, 'custom', 'code', '{}', $4, $5, true)`,
    [org.orgId, w.teamId, w.name, JSON.stringify(w.code), JSON.stringify(w.phases)],
  );
  const run: CodeReviewRun = {
    id: randomUUID(),
    teamId: org.teamId,
    projectId: p.projectId,
    taskId: null,
    ownerUserId: org.user("tadmin"),
    taskType: "feature",
    headSha: pr?.headSha ?? "",
    pr: { number, url, branch, baseBranch: "main" },
    stats: { addedLines: 5, deletedLines: 1, changedFiles: ["src/a.ts"] },
    reasons: [],
  };
  const review = await sys((tx) => startCodeReview(tx, run, deps));
  for (const j of queued.splice(0)) await handleCodeReviewJob(deps, j);
  return review?.id ?? "";
}

const overdueFor = async (reviewId: string) =>
  (
    await admin.query(
      `select i.user_id, i.title from hive.inbox_items i
       where i.org_id = $1 and i.event = 'code_review.overdue' and i.event_key like 'code-review-overdue:%'
         and i.event_key in (select 'code-review-overdue:' || id from hive.code_review_gate_runs where review_id = $2)`,
      [org.orgId, reviewId],
    )
  ).rows;
const backdate = (reviewId: string) =>
  admin.query("update hive.code_review_gate_runs set due_at = now() - interval '1 minute' where review_id = $1", [
    reviewId,
  ]);

describe("nhắc hạn checkpoint người duyệt", () => {
  it("chưa quá hạn: không nhắc", async () => {
    const id = await waitingReview();
    await remindOverdueCodeReviews(sla);
    expect(await overdueFor(id)).toEqual([]);
  });

  it("quá hạn: báo người được chỉ định và quản trị đội đúng một lần", async () => {
    const id = await waitingReview([org.user("tmember")]);
    await backdate(id);
    expect(await remindOverdueCodeReviews(sla)).toBeGreaterThanOrEqual(1);
    const rows = await overdueFor(id);
    const users = rows.map((r) => r.user_id);
    expect(users).toContain(org.user("tmember"));
    expect(users).toContain(org.user("tadmin"));
    expect(new Set(users).size).toBe(users.length);
    expect(rows[0].title).toContain("Quá hạn duyệt");

    const before = rows.length;
    await remindOverdueCodeReviews(sla);
    expect((await overdueFor(id)).length).toBe(before);
    const { rows: marked } = await admin.query(
      "select overdue_notified_at from hive.code_review_gate_runs where review_id = $1",
      [id],
    );
    expect(marked[0].overdue_notified_at).not.toBeNull();
  });

  it("phiên đã huỷ thì không nhắc", async () => {
    const id = await waitingReview();
    await backdate(id);
    await admin.query("update hive.code_reviews set status = 'cancelled' where id = $1", [id]);
    await remindOverdueCodeReviews(sla);
    expect(await overdueFor(id)).toEqual([]);
  });
});
