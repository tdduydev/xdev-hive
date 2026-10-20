import { randomBytes, randomUUID } from "node:crypto";
import {
  CODE_WORKFLOW_PRESETS,
  DEFAULT_AGENT_POLICY,
  type ReviewGateInput,
  type WorkflowInput,
  workflowInput,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveAgentPolicy } from "../governance/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import type { Principal, Reader } from "./access.ts";
import { saveDoc } from "./docs.ts";
import { editorState, previewSubmit } from "./editor.ts";
import { approveProposal, createProposal, provideProposalApproved, rejectProposal } from "./proposals.ts";
import { remindOverdue } from "./review-jobs.ts";
import {
  AI_AUTO_ACTOR,
  applyAiResult,
  type BaselineEvent,
  DERIVED_WORKFLOW_ID,
  decideReview,
  dryRunWorkflow,
  eligible,
  getReview,
  listCodeWorkflows,
  listReviews,
  listWorkflows,
  proposeWithReview,
  provideReviewHooks,
  type ReviewDeps,
  removeWorkflow,
  saveWorkflow,
  startReview,
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

  it("người duyệt theo đội: thành viên đội đó duyệt được, người ngoài đội thì không; chi tiết có cấu hình gate", async () => {
    await as("tadmin", (tx) =>
      saveWorkflow(
        tx,
        org.user("tadmin"),
        workflow([human("legal", { reviewers: { users: [], roles: [], teams: [org.otherTeamId], quorum: 1 } })]),
      ),
    );
    const p = await propose("tmember");
    const inst = await instanceOf(p.id);
    const d = await as("oadmin", (tx) => getReview(tx, org.user("oadmin"), inst.id)).catch(() => null);
    // oadmin không đọc được tài liệu của đội Thanh toán; quyền đọc vẫn theo phạm vi tài liệu.
    expect(d).toBeNull();
    const detail = await as("tadmin", (tx) => getReview(tx, org.user("tadmin"), inst.id));
    expect(detail.currentGate).toMatchObject({ id: "legal", reviewers: { teams: [org.otherTeamId] } });
    expect(detail.canDecide).toBe(false);
    // Thêm tadmin vào đội kia thì duyệt được.
    await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'member')", [
      org.otherTeamId,
      org.orgId,
      org.user("tviewer"),
    ]);
    const viaTeam = await as("tviewer", (tx) => getReview(tx, org.user("tviewer"), inst.id));
    expect(viaTeam.canDecide).toBe(true);
    await admin.query("delete from hive.team_members where team_id = $1 and user_id = $2", [
      org.otherTeamId,
      org.user("tviewer"),
    ]);
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

describe("quy trình code", () => {
  const codeWorkflow = (extra: Partial<WorkflowInput> = {}): WorkflowInput => ({
    name: `Code ${randomUUID().slice(0, 4)}`,
    preset: "code-basic",
    subject: "code",
    teamId: org.teamId,
    docPrefixes: [],
    code: {
      projects: [projectKey],
      baseBranches: ["main"],
      taskTypes: [],
      paths: [],
      merge: "project",
      maxAgentRevisions: 2,
      dismissStaleApprovals: false,
    },
    phases: CODE_WORKFLOW_PRESETS["code-basic"],
    enabled: true,
    ...extra,
  });
  const save = (who: string, input: WorkflowInput) => as(who, (tx) => saveWorkflow(tx, org.user(who), input));
  const setPolicy = (allowed: string[]) =>
    as("admin", (tx) =>
      saveAgentPolicy(tx, org.user("admin"), {
        ...DEFAULT_AGENT_POLICY,
        allowedModels: { ...DEFAULT_AGENT_POLICY.allowedModels, claude: allowed },
      }),
    );

  it("lưu được, đọc lại đủ loại và phạm vi (không rơi về tài liệu); có audit kèm loại", async () => {
    const saved = await save("tadmin", codeWorkflow());
    expect(saved).toMatchObject({
      subject: "code",
      docPrefixes: [],
      code: { projects: [projectKey], merge: "project" },
    });
    const [listed] = (await as("tviewer", (tx) => listWorkflows(tx, user("tviewer")))).filter((w) => w.id === saved.id);
    expect(listed).toMatchObject({ subject: "code", code: { baseBranches: ["main"], maxAgentRevisions: 2 } });
    const row = (await admin.query("select subject, code from hive.review_workflows where id = $1", [saved.id]))
      .rows[0];
    expect(row.subject).toBe("code");
    expect(row.code.projects).toEqual([projectKey]);
    const audit = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'review_workflow.save' and target_id = $2",
      [org.orgId, saved.id],
    );
    expect(audit.rows[0]?.data).toMatchObject({ subject: "code" });
  });

  it("sửa quy trình code giữ nguyên loại; đổi loại thì bị từ chối", async () => {
    const saved = await save("tadmin", codeWorkflow());
    const edited = await save(
      "tadmin",
      codeWorkflow({
        id: saved.id,
        name: "Đổi tên",
        code: { ...codeWorkflow().code, ...saved.code, maxAgentRevisions: 4 },
      }),
    );
    expect(edited).toMatchObject({ subject: "code", name: "Đổi tên", code: { maxAgentRevisions: 4 } });
    const asDoc = workflow([human("po")], { id: saved.id });
    expect(await errorCode(() => save("tadmin", asDoc))).toBe("WORKFLOW_SUBJECT_FIXED");
  });

  it("quy trình tài liệu cũ không đổi: vẫn subject doc, code null, khớp tài liệu như trước", async () => {
    const doc = await save("tadmin", workflow([human("po")]));
    expect(doc).toMatchObject({ subject: "doc", code: null });
    // Quy trình code cùng đội không được chen vào việc chọn quy trình cho tài liệu.
    await save("tadmin", codeWorkflow());
    const p = await propose("tmember");
    expect((await instanceOf(p.id)).workflow_id).toBe(doc.id);
    expect(
      (await as("tviewer", (tx) => listWorkflows(tx, user("tviewer"), "doc"))).every((w) => w.subject === "doc"),
    ).toBe(true);
  });

  it("không có quy trình tài liệu thì quy trình code không bắt đề xuất tài liệu vào phiên duyệt", async () => {
    await save("tadmin", codeWorkflow());
    const p = await propose("tmember");
    expect(await instanceOf(p.id)).toBeUndefined();
  });

  it("lọc danh sách theo loại", async () => {
    const doc = await save("tadmin", workflow([human("po")]));
    const code = await save("tadmin", codeWorkflow());
    const ids = async (subject?: "doc" | "code") =>
      (await as("tviewer", (tx) => listWorkflows(tx, user("tviewer"), subject))).map((w) => w.id);
    expect(await ids("code")).toEqual([code.id]);
    expect(await ids("doc")).toEqual([doc.id]);
    expect((await ids()).sort()).toEqual([code.id, doc.id].sort());
  });

  it("quyền workflows.write: thành viên đội không lưu được; quản trị đội không lưu quy trình của tổ chức", async () => {
    expect(await errorCode(() => save("tmember", codeWorkflow()))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => save("tadmin", codeWorkflow({ teamId: null })))).toBe("ORG_ROLE_REQUIRED");
    expect(await save("admin", codeWorkflow({ teamId: null }))).toMatchObject({ teamId: null, subject: "code" });
  });

  it("quy tắc dành cho tài liệu bị từ chối ở quy trình code", async () => {
    const bad = codeWorkflow({
      phases: [{ name: "Kiểm", gates: [{ id: "r", name: "Quy tắc", kind: "rule", rules: ["sections"] }] }],
    });
    await expect(save("tadmin", bad)).rejects.toThrow(/chỉ dùng cho tài liệu/);
  });

  it("từ chối model bị chính sách agent cấm; model được phép và CLI không giới hạn thì lưu được", async () => {
    const withModel = (cli: "claude" | "codex", model: string) =>
      codeWorkflow({
        phases: [
          {
            name: "Review AI",
            gates: [
              {
                id: "ai",
                name: "Review AI",
                kind: "ai",
                ai: { checks: ["Đúng yêu cầu"], passScore: 7, reviewers: [{ cli, model }] },
              },
            ],
          },
        ],
      });
    await setPolicy(["claude-sonnet-5-5"]);
    try {
      expect(await errorCode(() => save("tadmin", withModel("claude", "claude-opus-5-5")))).toBe(
        "WORKFLOW_MODEL_FORBIDDEN",
      );
      await expect(save("tadmin", withModel("claude", "claude-sonnet-5-5"))).resolves.toMatchObject({
        subject: "code",
      });
      await expect(save("tadmin", withModel("codex", "gpt-bất-kỳ"))).resolves.toMatchObject({ subject: "code" });
    } finally {
      await admin.query("delete from hive.agent_policies where org_id = $1", [org.orgId]);
    }
  });

  it("chạy thử trên tài liệu chỉ nhận quy trình tài liệu", async () => {
    expect(
      await errorCode(() =>
        as("tviewer", (tx) => dryRunWorkflow(tx, user("tviewer"), { workflow: codeWorkflow(), docKey })),
      ),
    ).toBe("WORKFLOW_SUBJECT_MISMATCH");
  });

  it("listCodeWorkflows: chỉ quy trình code đang bật của tổ chức hoặc của đúng đội", async () => {
    const mine = await save("tadmin", codeWorkflow({ name: "Của đội" }));
    const orgWide = await save("admin", codeWorkflow({ name: "Của tổ chức", teamId: null }));
    await save("tadmin", codeWorkflow({ name: "Tắt", enabled: false }));
    await save("tadmin", workflow([human("po")]));
    const got = await as("tmember", (tx) => listCodeWorkflows(tx, { teamId: org.teamId, projectId }));
    expect(got.map((w) => w.id).sort()).toEqual([mine.id, orgWide.id].sort());
    expect(got.every((w) => w.subject === "code" && w.code)).toBe(true);
    // Đội khác chỉ thấy quy trình của tổ chức.
    const other = await as("tmember", (tx) => listCodeWorkflows(tx, { teamId: randomUUID(), projectId: null }));
    expect(other.map((w) => w.id)).toEqual([orgWide.id]);
  });
});

describe("điểm nối của AI SDLC", () => {
  const derived = (gates: ReviewGateInput[], name = "001 · Spec") => ({
    name,
    phases: workflowInput.parse({ ...workflow(gates), name }).phases,
  });
  const proposeWith = (who: string, hooks: ReviewDeps, content = PRD_V2) =>
    as(who, (tx) =>
      proposeWithReview(
        tx,
        user(who),
        { kind: "doc", key: docKey, content, baseVersion: docVersion, reason: "Thêm phí" },
        hooks,
      ),
    );
  const versionNow = async () =>
    (await admin.query("select current_version from hive.docs where key = $1", [docKey])).rows[0].current_version;
  const gateRun = async (instanceId: string, gateId: string) =>
    (
      await admin.query(
        "select * from hive.review_gate_runs where instance_id = $1 and gate_id = $2 order by started_at desc",
        [instanceId, gateId],
      )
    ).rows[0];
  const approve = (who: string, id: string, hooks: ReviewDeps) =>
    as(who, (tx) => decideReview(tx, org.user(who), { id, decision: "approve" }, hooks));

  afterEach(() => provideReviewHooks({}));

  it("workflowFor đi trước quy trình khớp tiền tố; không trả gì thì quy trình cũ vẫn áp", async () => {
    await as("tadmin", (tx) => saveWorkflow(tx, org.user("tadmin"), workflow([human("po")])));
    const workflowFor = vi.fn(async (_tx: Tx, key: string) => (key === docKey ? derived([human("lead")]) : null));
    const p = await proposeWith("tmember", { workflowFor });
    expect(workflowFor).toHaveBeenCalledWith(expect.anything(), docKey);
    expect(await instanceOf(p.id)).toMatchObject({ workflow_id: null, workflow_name: "001 · Spec", gate_index: 0 });
    expect((await instanceOf(p.id)).phases[0].gates[0].id).toBe("lead");

    await freshDoc();
    const q = await proposeWith("tmember", { workflowFor: async () => null });
    expect(await instanceOf(q.id)).toMatchObject({
      workflow_name: expect.stringContaining("PRD"),
      status: "in_review",
    });
    expect((await instanceOf(q.id)).workflow_id).not.toBeNull();
  });

  it("hook cài một lần cho cả hub (provideReviewHooks) áp cả ở bản xem trước của trình soạn", async () => {
    provideReviewHooks({ workflowFor: async (_tx, key) => (key === docKey ? derived([human("lead")]) : null) });
    const preview = await as("tmember", (tx) => previewSubmit(tx, user("tmember"), { key: docKey }));
    expect(preview.workflow).toEqual({ id: DERIVED_WORKFLOW_ID, name: "001 · Spec" });
    expect(preview.gates.map((g) => g.gateId)).toEqual(["lead"]);
    await as("tmember", (tx) => editorState(tx, user("tmember"), { key: docKey }));
    const p = await proposeWith("tmember", {});
    expect(await instanceOf(p.id)).toMatchObject({ workflow_name: "001 · Spec" });
    // Deps của lời gọi thắng hook cài chung.
    await freshDoc();
    const q = await proposeWith("tmember", { workflowFor: async () => null });
    expect(await instanceOf(q.id)).toBeUndefined();
  });

  it("onBaseline chạy trong transaction chốt phiên bản: lỗi thì bản mới không được lưu", async () => {
    const events: BaselineEvent[] = [];
    const hooks: ReviewDeps = {
      workflowFor: async () => derived([human("lead")]),
      onBaseline: async (_tx, e) => void events.push(e),
    };
    const p = await proposeWith("tmember", hooks);
    const inst = await instanceOf(p.id);
    await approve("tadmin", inst.id, hooks);
    expect(events).toEqual([
      { docKey, version: docVersion + 1, proposalId: p.id, reviewId: inst.id, reaffirm: false, autoApproved: false },
    ]);

    await freshDoc();
    const boom: ReviewDeps = {
      workflowFor: async () => derived([human("lead")]),
      onBaseline: async () => {
        throw new Error("sdlc lỗi");
      },
    };
    const q = await proposeWith("tmember", boom);
    await expect(approve("tadmin", (await instanceOf(q.id)).id, boom)).rejects.toThrow("sdlc lỗi");
    expect(await versionNow()).toBe(docVersion);
    expect((await instanceOf(q.id)).status).toBe("in_review");
  });

  it("chốt qua quy trình: hook của sdlc vẫn chạy cùng các bên đăng ký provideProposalApproved; nguồn word", async () => {
    const events: BaselineEvent[] = [];
    provideReviewHooks({
      workflowFor: async () => derived([human("lead")]),
      onBaseline: async (_tx, e) => void events.push(e),
    });
    const approved: Array<[string, string, string | undefined, number]> = [];
    const offs = ["docsync", "khác"].map((who) =>
      provideProposalApproved(async (_tx, p, doc) => void approved.push([who, p.status, p.origin?.kind, doc.version])),
    );
    try {
      const importFileId = randomUUID();
      const p = await as("tmember", (tx) =>
        proposeWithReview(
          tx,
          user("tmember"),
          { kind: "doc", key: docKey, content: PRD_V2, baseVersion: docVersion },
          {},
          { origin: { kind: "word", importFileId } },
        ),
      );
      expect(p.origin).toEqual({ kind: "word", importFileId });
      await approve("tadmin", (await instanceOf(p.id)).id, {});
      expect(events.map((e) => e.proposalId)).toEqual([p.id]);
      expect(approved).toEqual([
        ["docsync", "approved", "word", docVersion + 1],
        ["khác", "approved", "word", docVersion + 1],
      ]);
      const { rows } = await admin.query(
        "select v.source from hive.doc_versions v join hive.docs d on d.id = v.doc_id where d.key = $1 and v.version = $2",
        [docKey, docVersion + 1],
      );
      expect(rows[0]?.source).toBe("word");

      // Handler lỗi thì bản chốt rollback như onBaseline.
      await freshDoc();
      offs.push(
        provideProposalApproved(async () => {
          throw new Error("docsync lỗi");
        }),
      );
      const q = await proposeWith("tmember", {});
      await expect(approve("tadmin", (await instanceOf(q.id)).id, {})).rejects.toThrow("docsync lỗi");
      expect(await versionNow()).toBe(docVersion);
      expect((await instanceOf(q.id)).status).toBe("in_review");
    } finally {
      for (const off of offs) off();
    }
  });

  it("queueAuthorFix nhận việc sửa thì không tạo task chung; không nhận thì dùng task chung", async () => {
    const asked: string[] = [];
    const hooks = (taken: boolean): ReviewDeps => ({
      workflowFor: async () => derived([human("po")]),
      queueAuthorFix: async (_tx, r) => {
        asked.push(`${r.docKey}|${r.note}`);
        return taken;
      },
    });
    const tasksOf = async () =>
      Number((await admin.query("select count(*) from hive.tasks where project_id = $1", [projectId])).rows[0].count);
    const before = await tasksOf();
    const route = (id: string, h: ReviewDeps, note: string) =>
      as("tadmin", (tx) => decideReview(tx, org.user("tadmin"), { id, decision: "changes", note, route: "agent" }, h));

    const taken = hooks(true);
    const p = await proposeWith("tmember", taken);
    await route((await instanceOf(p.id)).id, taken, "Ghi rõ trần phí");
    expect(asked).toEqual([`${docKey}|Ghi rõ trần phí`]);
    expect(await tasksOf()).toBe(before);
    expect(await instanceOf(p.id)).toMatchObject({ status: "changes_requested", route: "agent" });

    await freshDoc();
    const declined = hooks(false);
    const q = await proposeWith("tmember", declined);
    await route((await instanceOf(q.id)).id, declined, "Thiếu rủi ro");
    expect(await tasksOf()).toBe(before + 1);
  });

  it("traceFor thay cách truy vết mặc định; trả null thì dùng cách cũ", async () => {
    const p = await proposeWith("tmember", { workflowFor: async () => derived([human("po")]) });
    const id = (await instanceOf(p.id)).id;
    const custom = [{ id: "FR-001", text: "Hoàn tiền", acceptance: [], tasks: [] }];
    const seen = vi.fn(async () => custom);
    const a = await as("tadmin", (tx) => getReview(tx, org.user("tadmin"), id, { traceFor: seen }));
    expect(a.trace).toEqual(custom);
    expect(seen).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ docKey, projectId }));
    const b = await as("tadmin", (tx) => getReview(tx, org.user("tadmin"), id, { traceFor: async () => null }));
    expect(b.trace.map((t) => t.id)).toEqual(["R-1", "R-2"]);
  });

  it("teamScope: vai trò của checkpoint tính trong đội đó, và người duyệt đội khác đọc được phiên", async () => {
    const gate = human("lead-crm", { reviewers: { users: [], roles: ["team-admin"], quorum: 1 } });
    const wf = derived([gate]);
    (wf.phases[0]?.gates[0]?.reviewers as { teamScope?: string }).teamScope = org.otherTeamId;
    const hooks: ReviewDeps = { workflowFor: async () => wf };
    const p = await proposeWith("tmember", hooks);
    const id = (await instanceOf(p.id)).id;
    // tadmin là quản trị đội sở hữu tài liệu nhưng checkpoint tính trong đội CRM.
    expect(
      await errorCode(() =>
        as("tadmin", (tx) => decideReview(tx, org.user("tadmin"), { id, decision: "approve" }, hooks)),
      ),
    ).toBe("REVIEW_NOT_REVIEWER");
    const seen = await as("oadmin", (tx) => getReview(tx, org.user("oadmin"), id, hooks));
    expect(seen).toMatchObject({ canDecide: true, awaitingMe: true });
    const done = await approve("oadmin", id, hooks);
    expect(done.status).toBe("approved");
    // Không có teamScope thì người đội khác vẫn không đọc được như trước.
    await freshDoc();
    const q = await proposeWith("tmember", { workflowFor: async () => derived([human("lead")]) });
    const qid = (await instanceOf(q.id)).id;
    expect(await errorCode(() => as("oadmin", (tx) => getReview(tx, org.user("oadmin"), qid)))).toBe(
      "REVIEW_NOT_FOUND",
    );
  });

  it("team-ba được chọn làm người duyệt: BA/PO của đội, và quản trị, thành viên đội đó", () => {
    const reader = (role: string | null, teamId = org.teamId): Reader => ({
      kind: "user",
      principal: { kind: "user", userId: "u" },
      orgRole: "member",
      teams: new Map(role ? [[teamId, role as never]] : []),
    });
    const gate = () =>
      workflowInput.parse(workflow([human("ba", { reviewers: { users: [], roles: ["team-ba"], quorum: 1 } })]))
        .phases[0]?.gates[0] as never;
    const scope = { teamId: org.teamId, projectId: null };
    expect(eligible(reader("ba"), gate(), scope)).toBe(true);
    expect(eligible(reader("member"), gate(), scope)).toBe(true);
    expect(eligible(reader("admin"), gate(), scope)).toBe(true);
    expect(eligible(reader("viewer"), gate(), scope)).toBe(false);
    expect(eligible(reader(null), gate(), scope)).toBe(false);
    // BA của đội khác không duyệt được tài liệu của đội này.
    expect(eligible(reader("ba", org.otherTeamId), gate(), scope)).toBe(false);
  });

  it("ruleContext cấp dữ liệu cho luật no-open-questions: còn câu hỏi mở thì trả về người viết", async () => {
    const gates: ReviewGateInput[] = [
      { id: "clear", name: "Hết câu hỏi", kind: "rule", rules: ["no-open-questions"] },
      human("po"),
    ];
    const open = (n: number): ReviewDeps => ({
      workflowFor: async () => derived(gates),
      ruleContext: async () => ({ openQuestions: n }),
    });
    const p = await proposeWith("tmember", open(2));
    expect(await instanceOf(p.id)).toMatchObject({ status: "changes_requested", route: "author" });
    const note = (await admin.query("select decision_note from hive.proposals where id = $1", [p.id])).rows[0];
    expect(note.decision_note).toContain("Không còn câu hỏi mở");

    await freshDoc();
    const q = await proposeWith("tmember", open(0));
    expect(await instanceOf(q.id)).toMatchObject({ status: "in_review", gate_index: 1 });

    // Chạy thử cũng đi qua hook.
    provideReviewHooks(open(1));
    const dry = await as("tviewer", (tx) => dryRunWorkflow(tx, user("tviewer"), { workflow: workflow(gates), docKey }));
    expect(dry.gates[0]?.checklist.map((c) => c.passed)).toEqual([true, false]);
  });

  describe("tự duyệt", () => {
    const decision = (score = 9.2) => ({
      approve: true as const,
      score,
      threshold: 9,
      approvalId: randomUUID(),
      reasons: ["Reviewer khác CLI với tác giả."],
    });

    it("đồng ý: ghi quyết định system:ai-auto, đi tiếp như người duyệt, chốt baseline", async () => {
      const events: BaselineEvent[] = [];
      const approvalId = randomUUID();
      const seen: unknown[] = [];
      const hooks: ReviewDeps = {
        workflowFor: async () =>
          derived([{ id: "ai", name: "AI kiểm", kind: "rule", rules: ["requirements"] }, human("po")]),
        autoDecide: async (_tx, req) => {
          seen.push(req);
          return { approve: true, score: 9.2, threshold: 9, approvalId };
        },
        onBaseline: async (_tx, e) => void events.push(e),
      };
      const p = await proposeWith("tmember", hooks);
      const inst = await instanceOf(p.id);
      expect(inst.status).toBe("approved");
      expect(await versionNow()).toBe(docVersion + 1);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        review: { id: inst.id, docKey, projectId },
        gate: { id: "po", kind: "human" },
        checkpoints: [{ gateId: "ai", kind: "rule", status: "passed", decidedBy: null }],
      });
      expect(events).toEqual([expect.objectContaining({ reaffirm: false, autoApproved: true })]);
      const run = await gateRun(inst.id, "po");
      expect(run).toMatchObject({ status: "passed", decided_by: AI_AUTO_ACTOR });
      expect(run.approvals).toEqual([
        { userId: AI_AUTO_ACTOR, at: expect.any(String), auto: { score: 9.2, threshold: 9, approvalId } },
      ]);
      const detail = await as("tadmin", (tx) => getReview(tx, org.user("tadmin"), inst.id));
      const po = detail.gates.find((g) => g.gateId === "po");
      expect(po).toMatchObject({
        status: "passed",
        decidedBy: "Tự duyệt AI",
        auto: { score: 9.2, threshold: 9, approvalId },
      });
      expect(po?.approvals[0]?.name).toBe("Tự duyệt AI");
      const audit = await admin.query(
        "select data from hive.audit_log where org_id = $1 and action = 'review.auto_approve' and target_id = $2",
        [org.orgId, inst.id],
      );
      expect(audit.rows[0]?.data).toMatchObject({ gate: "po", score: 9.2, threshold: 9, approvalId });
    });

    it("từ chối kèm lý do: checkpoint chờ người, lý do ghi ở note và audit; người duyệt xong thì baseline không phải tự duyệt", async () => {
      const events: BaselineEvent[] = [];
      const hooks: ReviewDeps = {
        workflowFor: async () => derived([human("po")]),
        autoDecide: async () => ({ approve: false, reason: "Điểm 8.7 < ngưỡng 9" }),
        onBaseline: async (_tx, e) => void events.push(e),
      };
      const p = await proposeWith("tmember", hooks);
      const inst = await instanceOf(p.id);
      expect(inst).toMatchObject({ status: "in_review", gate_index: 0 });
      expect(await gateRun(inst.id, "po")).toMatchObject({
        status: "waiting",
        note: "Không tự duyệt: Điểm 8.7 < ngưỡng 9",
      });
      const audit = await admin.query(
        "select data from hive.audit_log where org_id = $1 and action = 'review.auto_declined' and target_id = $2",
        [org.orgId, inst.id],
      );
      expect(audit.rows[0]?.data).toMatchObject({ gate: "po", reason: "Điểm 8.7 < ngưỡng 9" });
      await approve("tadmin", inst.id, hooks);
      expect(events).toEqual([expect.objectContaining({ autoApproved: false })]);
    });

    it("từ chối im lặng hoặc null: như không có hook", async () => {
      for (const answer of [{ approve: false as const }, null]) {
        await freshDoc();
        const p = await proposeWith("tmember", {
          workflowFor: async () => derived([human("po")]),
          autoDecide: async () => answer,
        });
        const inst = await instanceOf(p.id);
        expect(inst).toMatchObject({ status: "in_review", gate_index: 0 });
        expect((await gateRun(inst.id, "po")).note).toBeNull();
      }
    });

    it("hai checkpoint người: tự duyệt cái đầu, cái sau do người; chỉ hỏi khi mọi checkpoint trước đã đạt", async () => {
      const asked: string[] = [];
      const hooks: ReviewDeps = {
        workflowFor: async () => derived([human("po"), human("lead")]),
        autoDecide: async (_tx, req) => {
          asked.push(`${req.gate.id}:${req.checkpoints.map((c) => `${c.gateId}=${c.decidedBy}`).join(",")}`);
          return req.gate.id === "po" ? decision() : { approve: false, reason: "Tech lead luôn do người" };
        },
      };
      const p = await proposeWith("tmember", hooks);
      const inst = await instanceOf(p.id);
      expect(inst).toMatchObject({ status: "in_review", gate_index: 1 });
      expect(asked).toEqual(["po:", `lead:po=${AI_AUTO_ACTOR}`]);
      const detail = await as("tadmin", (tx) => getReview(tx, org.user("tadmin"), inst.id));
      expect(detail.gates.map((g) => g.status)).toEqual(["passed", "waiting"]);
      expect(detail.gate).toMatchObject({ id: "lead" });
    });
  });

  describe("duyệt lại baseline (reaffirm)", () => {
    const reaffirmProposal = (who: string) =>
      as(who, (tx) =>
        createProposal(tx, user(who), {
          kind: "doc",
          key: docKey,
          baseVersion: docVersion,
          content: PRD_V1,
          reason: "Duyệt lại sau khi thu hồi tự duyệt",
        }),
      );

    it("đạt thì gọi onBaseline với reaffirm và không tạo phiên bản mới", async () => {
      const events: BaselineEvent[] = [];
      const hooks: ReviewDeps = { onBaseline: async (_tx, e) => void events.push(e) };
      const p = await reaffirmProposal("tmember");
      const inst = await as("tadmin", (tx) =>
        startReview(tx, p.id, hooks, { workflow: derived([human("po")]), reaffirm: true }),
      );
      expect(inst).toMatchObject({ status: "in_review" });
      // Không lưu phiên bản nào nên bên đăng ký "đề xuất đã duyệt" không có tài liệu để xử lý.
      const approvedHook = vi.fn(async () => {});
      const off = provideProposalApproved(approvedHook);
      try {
        await approve("tadmin", inst?.id ?? "", hooks);
      } finally {
        off();
      }
      expect(approvedHook).not.toHaveBeenCalled();
      expect(await versionNow()).toBe(docVersion);
      const versions = await admin.query(
        "select count(*)::int as n from hive.doc_versions v join hive.docs d on d.id = v.doc_id where d.key = $1",
        [docKey],
      );
      expect(versions.rows[0].n).toBe(1);
      expect(events).toEqual([
        { docKey, version: docVersion, proposalId: p.id, reviewId: inst?.id, reaffirm: true, autoApproved: false },
      ]);
      const prop = await admin.query("select status, result_version from hive.proposals where id = $1", [p.id]);
      expect(prop.rows[0]).toMatchObject({ status: "approved", result_version: docVersion });
      const audit = await admin.query(
        "select 1 from hive.audit_log where action = 'review.reaffirm' and target_id = $1",
        [inst?.id],
      );
      expect(audit.rowCount).toBe(1);
    });

    it("trả lại thì đi theo luồng sửa thường, không gọi onBaseline", async () => {
      const onBaseline = vi.fn(async () => {});
      const p = await reaffirmProposal("tmember");
      const inst = await as("tadmin", (tx) =>
        startReview(tx, p.id, { onBaseline }, { workflow: derived([human("po")]), reaffirm: true }),
      );
      await as("tadmin", (tx) =>
        decideReview(
          tx,
          org.user("tadmin"),
          { id: inst?.id ?? "", decision: "changes", note: "Còn sai" },
          { onBaseline },
        ),
      );
      expect(await instanceOf(p.id)).toMatchObject({ status: "changes_requested", route: "author" });
      expect(onBaseline).not.toHaveBeenCalled();
      expect(await versionNow()).toBe(docVersion);
    });

    it("tài liệu đã sang phiên bản khác thì xác nhận cũ không đạt được", async () => {
      const p = await reaffirmProposal("tmember");
      const inst = await as("tadmin", (tx) =>
        startReview(tx, p.id, {}, { workflow: derived([human("po")]), reaffirm: true }),
      );
      await as("tadmin", (tx) =>
        saveDoc(tx, user("tadmin"), { key: docKey, content: PRD_V2, baseVersion: docVersion }),
      );
      expect(await errorCode(() => approve("tadmin", inst?.id ?? "", {}))).toBe("VERSION_CONFLICT");
    });
  });
});
