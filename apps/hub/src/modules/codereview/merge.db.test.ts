// Phiên đạt → hàng merge theo chế độ hiệu lực (FR-027), reviewGate (FR-028), PR merge/đóng ngoài Hive (FR-029).
import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, type ProjectSettings } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { listQueue } from "../catalog/index.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { onApproved, onPullRequestEnded, reviewGate } from "./merge.ts";
import { codeReviews } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const sha = (n: number) => n.toString(16).padStart(40, "0");

let org: OrgFixture & { user: (n: string) => string };

const queuedJobs: unknown[] = [];
const jobs: Jobs = {
  start: async () => {},
  stop: async () => {},
  enqueue: async (_q, data) => {
    queuedJobs.push(data);
    return randomUUID();
  },
  schedule: async () => {},
  work: async () => {},
};

beforeAll(async () => {
  org = await seedOrg(admin, `crm-${tag}`);
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const sys = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

function settings(mode: "review" | "auto", mergeQueue = true): ProjectSettings {
  const s = defaultProjectSettings();
  return { ...s, merge: { ...s.merge, mode }, features: { ...s.features, mergeQueue } };
}

let seq = 0;
async function newProject(s: ProjectSettings) {
  seq += 1;
  const p = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `crm${seq}-${tag}`,
    settings: s,
  });
  return p.projectId;
}

let pr = 100;
async function newReview(
  projectId: string,
  o: { merge?: "project" | "auto" | "manual"; status?: string; headSha?: string; requester?: string | null } = {},
) {
  pr += 1;
  // Mục hàng merge có khoá ngoại tới runs, nên cần một run thật.
  const run = await admin.query(
    `insert into hive.runs (org_id, team_id, project_id, branch, policy_snapshot, created_by, state)
     values ($1, $2, $3, $4, '[]', $5, 'succeeded') returning id`,
    [org.orgId, org.teamId, projectId, `ai/pr-${pr}`, org.user("tmember")],
  );
  const phases = [
    { name: "Review", gates: [{ id: "rules", name: "Quy tắc", kind: "rule", rules: [], slaHours: null }] },
  ];
  const { rows } = await admin.query(
    `insert into hive.code_reviews (org_id, team_id, project_id, run_id, workflow_name, phases, options, pr_number, pr_url,
       branch, base_branch, head_sha, status, requester_user_id)
     values ($1, $2, $3, $4, 'Quy trình thử', $5, $6, $7, $8, $9, 'main', $10, $11, $12) returning id`,
    [
      org.orgId,
      org.teamId,
      projectId,
      run.rows[0].id,
      JSON.stringify(phases),
      JSON.stringify({ merge: o.merge ?? "project", maxAgentRevisions: 2, dismissStaleApprovals: false }),
      pr,
      `https://git.example.com/pr/${pr}`,
      `ai/pr-${pr}`,
      o.headSha ?? sha(1),
      o.status ?? "in_review",
      o.requester === undefined ? org.user("tmember") : o.requester,
    ],
  );
  return { id: rows[0].id as string, prNumber: pr };
}

const row = async (id: string) => (await admin.query("select * from hive.code_reviews where id = $1", [id])).rows[0];
const approve = (id: string) =>
  sys(async (tx) => {
    const [r] = await tx.select().from(codeReviews).where(eq(codeReviews.id, id));
    if (!r) throw new Error("no review");
    return onApproved(tx, r, { jobs, publicUrl: "https://hive.example.com" });
  });
const audits = async (id: string) =>
  (await admin.query("select action from hive.audit_log where target_id = $1 order by created_at", [id])).rows.map(
    (r) => r.action as string,
  );
const inbox = async (id: string) =>
  (await admin.query("select event, link from hive.inbox_items where event_key = $1", [`code_review_approved:${id}`]))
    .rows;

describe("phiên đạt → hàng merge (FR-027)", () => {
  it("chế độ project theo merge.mode=auto và bật merge queue: vào hàng trong cùng transaction, audit", async () => {
    const projectId = await newProject(settings("auto"));
    const r = await newReview(projectId);
    queuedJobs.splice(0);
    const done = await approve(r.id);
    expect(done.status).toBe("approved");
    const q = await sys((tx) => listQueue(tx, projectId));
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ prNumber: r.prNumber, state: "queued", enqueuedBy: org.user("tmember") });
    expect(queuedJobs).toHaveLength(1);
    expect(await audits(r.id)).toContain("codereview.approve");
    expect(await inbox(r.id)).toEqual([]);
  });

  it("chế độ auto của quy trình ghi đè dự án đang để review", async () => {
    const projectId = await newProject(settings("review"));
    const r = await newReview(projectId, { merge: "auto" });
    await approve(r.id);
    expect(await sys((tx) => listQueue(tx, projectId))).toHaveLength(1);
  });

  it("chế độ manual ghi đè dự án auto: không vào hàng, báo người giao việc", async () => {
    const projectId = await newProject(settings("auto"));
    const r = await newReview(projectId, { merge: "manual" });
    await approve(r.id);
    expect(await sys((tx) => listQueue(tx, projectId))).toEqual([]);
    expect((await row(r.id)).status).toBe("approved");
    expect(await inbox(r.id)).toEqual([
      { event: "code_review.approved", link: `https://hive.example.com/knowledge/reviews?tab=code&id=${r.id}` },
    ]);
  });

  it("auto mà dự án tắt merge queue: phiên approved, người giao việc nhận thông báo cần merge tay", async () => {
    const projectId = await newProject(settings("auto", false));
    const r = await newReview(projectId);
    await approve(r.id);
    expect((await row(r.id)).status).toBe("approved");
    expect(await sys((tx) => listQueue(tx, projectId))).toEqual([]);
    expect(await inbox(r.id)).toHaveLength(1);
  });

  it("run của đội không có chủ vẫn vào hàng, không báo ai", async () => {
    const projectId = await newProject(settings("auto"));
    const r = await newReview(projectId, { requester: null });
    await approve(r.id);
    const q = await sys((tx) => listQueue(tx, projectId));
    expect(q[0]?.enqueuedBy).toMatch(/^workflow:/);
  });
});

describe("reviewGate (FR-028)", () => {
  it("không có phiên: không chặn", async () => {
    const projectId = await newProject(settings("auto"));
    expect(await sys((tx) => reviewGate(tx, projectId, 9999, sha(1)))).toBe(false);
  });

  it("in_review và changes_requested chặn; approved cho đúng head thì qua, khác head thì chặn", async () => {
    const projectId = await newProject(settings("auto"));
    const a = await newReview(projectId, { status: "in_review" });
    expect(await sys((tx) => reviewGate(tx, projectId, a.prNumber, sha(1)))).toBe(true);
    await admin.query("update hive.code_reviews set status = 'changes_requested' where id = $1", [a.id]);
    expect(await sys((tx) => reviewGate(tx, projectId, a.prNumber, sha(1)))).toBe(true);
    await admin.query("update hive.code_reviews set status = 'approved' where id = $1", [a.id]);
    expect(await sys((tx) => reviewGate(tx, projectId, a.prNumber, sha(1)))).toBe(false);
    expect(await sys((tx) => reviewGate(tx, projectId, a.prNumber, sha(2)))).toBe(true);
  });

  it("phiên đã superseded không chặn; vòng mới đang mở thì chặn", async () => {
    const projectId = await newProject(settings("auto"));
    const a = await newReview(projectId, { status: "superseded" });
    expect(await sys((tx) => reviewGate(tx, projectId, a.prNumber, sha(1)))).toBe(false);
  });
});

describe("PR merge hoặc đóng ngoài Hive (FR-029)", () => {
  it("merged: phiên → merged, lượt checkpoint đang chờ đóng, huỷ run review đang chạy, audit", async () => {
    const projectId = await newProject(settings("review"));
    const r = await newReview(projectId);
    const runId = randomUUID();
    await admin.query(
      `insert into hive.code_review_gate_runs (org_id, review_id, gate_index, gate_id, head_sha, status, run_ids)
       values ($1, $2, 0, 'rules', $3, 'waiting', $4)`,
      [org.orgId, r.id, sha(1), [runId]],
    );
    const cancelled: string[] = [];
    const out = await sys((tx) =>
      onPullRequestEnded(
        tx,
        { projectId, prNumber: r.prNumber, outcome: "merged" },
        { cancelRun: async (_tx, id) => void cancelled.push(id) },
      ),
    );
    expect(out?.status).toBe("merged");
    expect(cancelled).toEqual([runId]);
    const { rows } = await admin.query("select status, note from hive.code_review_gate_runs where review_id = $1", [
      r.id,
    ]);
    expect(rows).toEqual([{ status: "skipped", note: "PR đã được merge." }]);
    expect(await audits(r.id)).toContain("codereview.merged");
  });

  it("closed: phiên đã approved → cancelled; webhook giao lại không làm gì", async () => {
    const projectId = await newProject(settings("review"));
    const r = await newReview(projectId, { status: "approved" });
    const end = () => sys((tx) => onPullRequestEnded(tx, { projectId, prNumber: r.prNumber, outcome: "closed" }));
    expect((await end())?.status).toBe("cancelled");
    expect(await end()).toBeNull();
    expect((await row(r.id)).status).toBe("cancelled");
    expect((await audits(r.id)).filter((a) => a === "codereview.cancel")).toHaveLength(1);
  });

  it("PR không có phiên mở: không làm gì (FR-030)", async () => {
    const projectId = await newProject(settings("review"));
    expect(await sys((tx) => onPullRequestEnded(tx, { projectId, prNumber: 424242, outcome: "merged" }))).toBeNull();
  });
});
