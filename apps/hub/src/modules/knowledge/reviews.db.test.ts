import { randomBytes, randomUUID } from "node:crypto";
import type { ReviewGateInput, WorkflowInput } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import type { Principal } from "./access.ts";
import { saveDoc } from "./docs.ts";
import { approveProposal, rejectProposal } from "./proposals.ts";
import { remindOverdue } from "./review-jobs.ts";
import {
  applyAiResult,
  decideReview,
  dryRunWorkflow,
  getReview,
  listReviews,
  listWorkflows,
  proposeWithReview,
  removeWorkflow,
  saveWorkflow,
} from "./reviews.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

type Fixture = OrgFixture & { user: (n: string) => string };
let org: Fixture;
let projectKey = "";
let projectId = "";

const user = (who: string): Principal => ({ kind: "user", userId: org.user(who) });
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const deps = {};

const PRD_V1 =
  "# PRD hoàn tiền\n\n## Yêu cầu\n\n- R-1: Hoàn tiền trong 7 ngày\n  - Tiêu chí: đơn hoàn trong 7 ngày được duyệt\n";
const PRD_V2 =
  "# PRD hoàn tiền\n\n## Yêu cầu\n\n- R-1: Hoàn tiền trong 7 ngày\n  - Tiêu chí: đơn hoàn trong 7 ngày được duyệt\n- R-2: Có phí hoàn tiền 2%\n  - Tiêu chí: phí hiện trên hoá đơn\n";

const human = (id: string, extra: Partial<ReviewGateInput> = {}): ReviewGateInput => ({
  id,
  name: `Duyệt ${id}`,
  kind: "human",
  reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
  slaHours: 24,
  ...extra,
});

function workflow(gates: ReviewGateInput[], extra: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    name: `PRD ${randomUUID().slice(0, 4)}`,
    preset: "custom",
    teamId: org.teamId,
    docPrefixes: [`project/${projectKey}/prd`],
    phases: [{ name: "Inception", gates }],
    enabled: true,
    ...extra,
  };
}

let docKey = "";
let docVersion = 0;
async function freshDoc(content = PRD_V1) {
  docKey = `project/${projectKey}/prd-${randomUUID().slice(0, 6)}`;
  const d = await as("tadmin", (tx) =>
    saveDoc(tx, user("tadmin"), { key: docKey, title: "PRD hoàn tiền", content, baseVersion: 0 }),
  );
  docVersion = d.version;
}

const propose = (who: string, content = PRD_V2, base = docVersion) =>
  as(who, (tx) =>
    proposeWithReview(
      tx,
      user(who),
      { kind: "doc", key: docKey, content, baseVersion: base, reason: "Thêm phí" },
      deps,
    ),
  );

async function instanceOf(proposalId: string) {
  return (await admin.query("select * from hive.review_instances where proposal_id = $1", [proposalId])).rows[0];
}

beforeAll(async () => {
  org = await seedOrg(admin, `rv-${tag}`);
  projectKey = `pay-${tag}`;
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: projectKey,
    })
  ).projectId;
});

beforeEach(async () => {
  await admin.query("delete from hive.review_workflows where org_id = $1", [org.orgId]);
  await freshDoc();
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("quy trình", () => {
  it("quản trị đội tạo quy trình của đội, thành viên không được; có audit; xoá giữ phiên đang chạy", async () => {
    expect(
      await errorCode(() => as("tmember", (tx) => saveWorkflow(tx, org.user("tmember"), workflow([human("po")])))),
    ).toBe("TEAM_ROLE_REQUIRED");
    expect(
      await errorCode(() =>
        as("tadmin", (tx) => saveWorkflow(tx, org.user("tadmin"), workflow([human("po")], { teamId: null }))),
      ),
    ).toBe("ORG_ROLE_REQUIRED");
    const wf = await as("tadmin", (tx) => saveWorkflow(tx, org.user("tadmin"), workflow([human("po")])));
    expect(wf).toMatchObject({ teamId: org.teamId, enabled: true, inFlight: 0 });
    const p = await propose("tmember");
    const list = await as("tviewer", (tx) => listWorkflows(tx, user("tviewer")));
    expect(list.find((w) => w.id === wf.id)?.inFlight).toBe(1);
    await as("tadmin", (tx) => removeWorkflow(tx, org.user("tadmin"), wf.id));
    expect((await instanceOf(p.id)).status).toBe("in_review");
    const audit = await admin.query(
      "select action from hive.audit_log where org_id = $1 and action like 'review%' order by created_at",
      [org.orgId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["review_workflow.save", "review.start", "review_workflow.remove"]),
    );
  });

  it("checkpoint thiếu người duyệt hay mã trùng thì không lưu", async () => {
    const bad = workflow([
      { id: "x", name: "Người duyệt", kind: "human", reviewers: { users: [], roles: [], quorum: 1 } },
    ]);
    await expect(as("tadmin", (tx) => saveWorkflow(tx, org.user("tadmin"), bad))).rejects.toThrow(/cần người duyệt/);
    await expect(
      as("tadmin", (tx) => saveWorkflow(tx, org.user("tadmin"), workflow([human("a"), human("a")]))),
    ).rejects.toThrow(/trùng/);
  });

  it("chạy thử: gate nào chạy, gate nào bỏ qua và kết quả quy tắc trên bản hiện tại", async () => {
    await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key: docKey, content: PRD_V2, baseVersion: docVersion }));
    const wf = workflow([
      { id: "trace", name: "Truy vết", kind: "rule", rules: ["requirements"] },
      human("legal", {
        conditions: { docTypes: [], keywords: ["thuế"], minChangedLines: null, skipFormattingOnly: false },
      }),
      human("adr-only", {
        conditions: { docTypes: ["adr"], keywords: [], minChangedLines: null, skipFormattingOnly: false },
      }),
    ]);
    const res = await as("tviewer", (tx) => dryRunWorkflow(tx, user("tviewer"), { workflow: wf, docKey }));
    expect(res.matched).toBe(true);
    expect(res.gates.map((g) => [g.gateId, g.runs])).toEqual([
      ["trace", true],
      ["legal", false],
      ["adr-only", false],
    ]);
    expect(res.gates[0]?.checklist.map((c) => [c.label, c.passed])).toEqual([
      ["R-1 có tiêu chí chấp nhận", true],
      ["R-2 có tiêu chí chấp nhận", true],
    ]);
  });
});

describe("phiên duyệt", () => {
  it("tài liệu không khớp quy trình nào thì đề xuất như cũ", async () => {
    const p = await propose("tmember");
    expect(await instanceOf(p.id)).toBeUndefined();
  });

  it("qua quy tắc rồi chờ người duyệt; người viết không tự duyệt; duyệt xong thì chốt phiên bản mới", async () => {
    await as("tadmin", (tx) =>
      saveWorkflow(
        tx,
        org.user("tadmin"),
        workflow([{ id: "trace", name: "Truy vết", kind: "rule", rules: ["requirements"] }, human("po")]),
      ),
    );
    const p = await propose("tmember");
    const inst = await instanceOf(p.id);
    expect(inst).toMatchObject({ status: "in_review", gate_index: 1, added_lines: 2 });
    const mine = await as("tadmin", (tx) => listReviews(tx, org.user("tadmin"), { scope: "mine" }));
    const ofDoc = mine.items.filter((r) => r.docKey === docKey);
    expect(ofDoc.map((r) => r.id)).toEqual([inst.id]);
    expect(ofDoc[0]).toMatchObject({ awaitingMe: true, gate: { id: "po", kind: "human", sla: "on-time" } });
    const memberMine = await as("tmember", (tx) => listReviews(tx, org.user("tmember"), { scope: "mine" }));
    expect(memberMine.items.filter((r) => r.docKey === docKey)).toEqual([]);
    expect(
      await errorCode(() =>
        as("tmember", (tx) => decideReview(tx, org.user("tmember"), { id: inst.id, decision: "approve" }, deps)),
      ),
    ).toBe("REVIEW_NOT_REVIEWER");
    // Đề xuất đang theo quy trình thì không duyệt tay ở trang Đề xuất.
    expect(await errorCode(() => as("tadmin", (tx) => approveProposal(tx, user("tadmin"), { id: p.id })))).toBe(
      "PROPOSAL_IN_REVIEW",
    );
    const detail = await as("tadmin", (tx) =>
      decideReview(tx, org.user("tadmin"), { id: inst.id, decision: "approve" }, deps),
    );
    expect(detail.status).toBe("approved");
    expect(detail.gates.map((g) => [g.gateId, g.status])).toEqual([
      ["trace", "passed"],
      ["po", "passed"],
    ]);
    expect(detail.trace.map((t) => [t.id, t.acceptance.length])).toEqual([
      ["R-1", 1],
      ["R-2", 1],
    ]);
    const doc = await admin.query("select current_version from hive.docs where key = $1", [docKey]);
    expect(doc.rows[0].current_version).toBe(docVersion + 1);
    const prop = await admin.query("select status, result_version from hive.proposals where id = $1", [p.id]);
    expect(prop.rows[0]).toMatchObject({ status: "approved", result_version: docVersion + 1 });
  });

  it("quy tắc không đạt thì trả về người viết và từ chối đề xuất", async () => {
    await as("tadmin", (tx) =>
      saveWorkflow(
        tx,
        org.user("tadmin"),
        workflow([{ id: "trace", name: "Truy vết", kind: "rule", rules: ["requirements"] }]),
      ),
    );
    const p = await propose("tmember", "# PRD\n\n- R-1: Hoàn tiền nhanh\n");
    expect(await instanceOf(p.id)).toMatchObject({ status: "changes_requested", route: "author" });
    const prop = await admin.query("select status, decision_note from hive.proposals where id = $1", [p.id]);
    expect(prop.rows[0].status).toBe("rejected");
    expect(prop.rows[0].decision_note).toContain("R-1 có tiêu chí chấp nhận");
  });

  it("điều kiện: bỏ qua gate khi chỉ sửa định dạng, khi không nhắc từ khoá", async () => {
    await as("tadmin", (tx) =>
      saveWorkflow(
        tx,
        org.user("tadmin"),
        workflow([
          human("po", { conditions: { docTypes: [], keywords: [], minChangedLines: null, skipFormattingOnly: true } }),
          human("legal", {
            conditions: { docTypes: [], keywords: ["thuế"], minChangedLines: null, skipFormattingOnly: false },
          }),
        ]),
      ),
    );
    const p = await propose("tmember", PRD_V1.replace("Hoàn tiền trong 7 ngày", "**Hoàn tiền trong 7 ngày**"));
    const instId = (await instanceOf(p.id)).id;
    const d = await as("tadmin", (tx) => getReview(tx, org.user("tadmin"), instId));
    expect(d.status).toBe("approved");
    expect(d.gates.map((g) => g.status)).toEqual(["skipped", "skipped"]);
  });

  it("cần hai người duyệt chỉ định; trả về checkpoint trước; trả cho agent sửa rồi tiếp tục ở checkpoint đó", async () => {
    await as("tadmin", (tx) =>
      saveWorkflow(
        tx,
        org.user("tadmin"),
        workflow([
          human("po"),
          human("legal", { reviewers: { users: [org.user("tmember"), org.user("tviewer")], roles: [], quorum: 0 } }),
        ]),
      ),
    );
    const p = await propose("admin");
    const inst = await instanceOf(p.id);
    await as("tadmin", (tx) => decideReview(tx, org.user("tadmin"), { id: inst.id, decision: "approve" }, deps));
    let d = await as("tmember", (tx) =>
      decideReview(tx, org.user("tmember"), { id: inst.id, decision: "approve" }, deps),
    );
    expect(d).toMatchObject({ status: "in_review", gate: { id: "legal" } });
    expect(d.gates[1]?.approvals.map((a) => a.userId)).toEqual([org.user("tmember")]);
    // Người thứ hai trả về checkpoint trước: phiên quay lại chờ Product owner.
    d = await as("tviewer", (tx) =>
      decideReview(
        tx,
        org.user("tviewer"),
        { id: inst.id, decision: "changes", note: "Hỏi lại PO về phí", route: "previous" },
        deps,
      ),
    );
    expect(d).toMatchObject({ status: "in_review", gate: { id: "po" }, previousGate: null });
    // PO trả cho agent sửa: tạo việc trong dự án, đề xuất bị từ chối.
    d = await as("tadmin", (tx) =>
      decideReview(
        tx,
        org.user("tadmin"),
        { id: inst.id, decision: "changes", note: "Ghi rõ trần phí", route: "agent" },
        deps,
      ),
    );
    expect(d.status).toBe("changes_requested");
    const task = await admin.query(
      "select title, body from hive.tasks where project_id = $1 order by created_at desc limit 1",
      [projectId],
    );
    expect(task.rows[0].title).toContain("Sửa tài liệu");
    expect(task.rows[0].body).toContain("Ghi rõ trần phí");
    // Agent đề xuất lại: phiên mới tiếp tục ở checkpoint đã trả về (po), không chạy lại từ đầu.
    const again = await withTenant(app, { orgId: org.orgId }, (tx) =>
      proposeWithReview(
        tx,
        { kind: "run", runId: randomUUID(), projectId },
        {
          kind: "doc",
          key: docKey,
          content: `${PRD_V2}\nTrần phí 50.000đ.\n`,
          baseVersion: docVersion,
          reason: "Theo góp ý",
        },
        deps,
      ),
    );
    expect(await instanceOf(again.id)).toMatchObject({ status: "in_review", gate_index: 0 });
  });

  it("từ chối ở trang Đề xuất thì huỷ phiên duyệt", async () => {
    await as("tadmin", (tx) => saveWorkflow(tx, org.user("tadmin"), workflow([human("po")])));
    const p = await propose("tmember");
    await as("tadmin", (tx) => rejectProposal(tx, user("tadmin"), { id: p.id, note: "Không cần" }));
    expect((await instanceOf(p.id)).status).toBe("cancelled");
  });

  it("gate AI chờ kết quả agent: đạt ngưỡng thì đi tiếp, dưới ngưỡng thì trả về người viết", async () => {
    const aiGate: ReviewGateInput = { id: "ai", name: "AI kiểm", kind: "ai", ai: { checks: ["Đủ mục"], passScore: 7 } };
    await as("tadmin", (tx) => saveWorkflow(tx, org.user("tadmin"), workflow([aiGate, human("po")])));
    const ok = await propose("tmember");
    const okInst = await instanceOf(ok.id);
    expect(okInst).toMatchObject({ status: "in_review", gate_index: 0 });
    await withTenant(app, { orgId: org.orgId }, (tx) =>
      applyAiResult(
        tx,
        {
          kind: "ai-result",
          orgId: org.orgId,
          instanceId: okInst.id,
          runId: randomUUID(),
          score: 8.5,
          checklist: [{ label: "Đủ mục", passed: true, note: null }],
          summary: "Ổn",
          error: null,
        },
        deps,
      ),
    );
    const d = await as("tadmin", (tx) => getReview(tx, org.user("tadmin"), okInst.id));
    expect(d).toMatchObject({ gate: { id: "po" }, aiScore: 8.5 });
    expect(d.gates[0]).toMatchObject({ status: "passed", score: 8.5, checklist: [{ label: "Đủ mục", passed: true }] });

    await freshDoc();
    const low = await propose("tmember");
    const lowInst = await instanceOf(low.id);
    await withTenant(app, { orgId: org.orgId }, (tx) =>
      applyAiResult(
        tx,
        {
          kind: "ai-result",
          orgId: org.orgId,
          instanceId: lowInst.id,
          runId: randomUUID(),
          score: 5,
          checklist: [],
          summary: null,
          error: null,
        },
        deps,
      ),
    );
    expect(await instanceOf(low.id)).toMatchObject({ status: "changes_requested" });
  });

  it("quá hạn thì nhắc một lần cho người duyệt và quản trị", async () => {
    await as("tadmin", (tx) => saveWorkflow(tx, org.user("tadmin"), workflow([human("po", { slaHours: 1 })])));
    const p = await propose("tmember");
    const inst = await instanceOf(p.id);
    await admin.query("update hive.review_gate_runs set due_at = now() - interval '1 minute' where instance_id = $1", [
      inst.id,
    ]);
    const list = await as("tadmin", (tx) => listReviews(tx, org.user("tadmin"), { scope: "all" }));
    expect(list.items.find((r) => r.id === inst.id)?.gate?.sla).toBe("overdue");
    expect(
      await remindOverdue({
        pool: app,
        providerFactory: () => {
          throw new Error("không dùng");
        },
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await remindOverdue({
        pool: app,
        providerFactory: () => {
          throw new Error("không dùng");
        },
      }),
    ).toBe(0);
    const inbox = await admin.query(
      "select count(*)::int as n from hive.inbox_items where org_id = $1 and event = 'review.overdue'",
      [org.orgId],
    );
    expect(inbox.rows[0].n).toBeGreaterThan(0);
  });
});
