import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  defaultProjectSettings,
  projectSdlcSettings,
  type ReviewPhase,
  reviewPhase,
  SDLC_PRESETS,
  type SdlcItemCreate,
  type SdlcMode,
  sdlcMode,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveDoc } from "../knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createItem, getItem } from "./items.ts";
import { saveMode } from "./modes.ts";
import {
  advance,
  approvePhase,
  expandPerProjectGates,
  type ItemTeam,
  itemTeams,
  onBaseline,
  type SdlcDeps,
  type SdlcStepStart,
  skipPhase,
  workflowFor,
} from "./phases.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const custom = `hai-tl-${tag}`;

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";
let projectKey = "";
let started: SdlcStepStart[] = [];
/** Không có hàng đợi: `advance` chạy ngay trong transaction, test thấy kết quả không cần pg-boss. */
const deps: SdlcDeps = {
  startSdlcRun: async (_tx, input) => {
    started.push(input);
    return { runId: randomUUID() };
  },
};

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

const speckit = SDLC_PRESETS.speckit as SdlcMode;

/**
 * Speckit với Specify có hai tài liệu bắt buộc và một tuỳ chọn; Plan chỉ cho cỡ L (để thử bỏ giai đoạn theo cỡ).
 */
function twoDocsMode(): SdlcMode {
  const m = structuredClone(speckit);
  m.id = custom;
  m.name = "Hai tài liệu";
  const specify = m.phases.find((p) => p.id === "specify");
  const plan = m.phases.find((p) => p.id === "plan");
  const spec = specify?.artifacts[0];
  if (!specify || !plan || !spec) throw new Error("speckit đổi cấu trúc");
  specify.artifacts.push(
    {
      ...structuredClone(spec),
      id: "glossary",
      name: "Thuật ngữ",
      path: "specs/{NNN}-{slug}/glossary.md",
    },
    {
      ...structuredClone(spec),
      id: "notes",
      name: "Ghi chú",
      required: false,
      path: "specs/{NNN}-{slug}/notes.md",
    },
  );
  plan.sizes = ["L"];
  return sdlcMode.parse(m);
}

const create = (who: string, over: Partial<SdlcItemCreate> = {}) =>
  as(who, (tx) =>
    createItem(
      tx,
      org.user(who),
      {
        projectId,
        title: "Hoàn tiền một phần",
        idea: "Cho phép hoàn tiền một phần cho đơn hàng đã thanh toán, có ghi lý do.",
        modeRef: custom,
        size: "M",
        ...over,
      },
      deps,
    ),
  );

const detail = (id: string) => as("tadmin", (tx) => getItem(tx, org.user("tadmin"), { id }));

/** Lưu một phiên bản tài liệu rồi báo baseline như `knowledge.finish`. */
async function baseline(docKey: string, content: string, extra: { reaffirm?: boolean; autoApproved?: boolean } = {}) {
  return as("tadmin", async (tx) => {
    const doc = await saveDoc(
      tx,
      { kind: "user", userId: org.user("tadmin") },
      { key: docKey, content, baseVersion: 0 },
    );
    await onBaseline(
      tx,
      { docKey, version: doc.version, proposalId: randomUUID(), reviewId: randomUUID(), ...extra },
      deps,
    );
    return doc.version;
  });
}

async function auditOf(action: string, targetId: string) {
  const { rows } = await admin.query(
    "select data from hive.audit_log where org_id = $1 and action = $2 and target_id = $3 order by created_at",
    [org.orgId, action, targetId],
  );
  return rows.map((r) => r.data as Record<string, unknown>);
}

beforeAll(async () => {
  org = await seedOrg(admin, `sdp-${tag}`);
  projectKey = `sp${tag}`;
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: projectKey,
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({
          enabled: true,
          defaultMode: "speckit",
          modes: ["speckit", "bugfix", custom],
        }),
      },
    })
  ).projectId;
  await as("tadmin", (tx) =>
    saveMode(tx, org.user("tadmin"), {
      teamId: org.teamId,
      slug: custom,
      basePreset: "speckit",
      definition: twoDocsMode(),
    }),
  );
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.doc_drafts where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.docs where org_id = $1", [org.orgId]);
  started = [];
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("giai đoạn theo cỡ", () => {
  it("giai đoạn ngoài cỡ bị bỏ ngay lúc tạo, có ghi chú; cỡ phù hợp thì chờ tới lượt", async () => {
    const m = await create("tmember", { size: "M" });
    expect(m.phases.find((p) => p.id === "plan")).toMatchObject({ status: "skipped", note: "Bỏ qua với cỡ M." });
    const l = await create("tmember", { size: "L", title: "Hoàn tiền toàn phần" });
    expect(l.phases.find((p) => p.id === "plan")).toMatchObject({ status: "pending", note: null });
  });
});

describe("advance và onBaseline", () => {
  it("chạy bước tự động; đủ hai tài liệu bắt buộc mới đạt, tài liệu tuỳ chọn không chặn; sang giai đoạn kế", async () => {
    const item = await create("tmember");
    // Giai đoạn đầu chạy bước soạn tự động; gọi lại không tạo bước thứ hai khi bước trước chưa xong.
    expect(started.map((s) => [s.phase.id, s.step.id, s.requestedBy])).toEqual([["specify", "draft-spec", null]]);
    await as("tadmin", (tx) => advance(tx, item.id, deps));
    expect(started).toHaveLength(1);
    const { rows: steps } = await admin.query(
      "select step_id, status, run_id, created_by from hive.sdlc_steps where item_id = $1",
      [item.id],
    );
    expect(steps).toEqual([
      expect.objectContaining({ step_id: "draft-spec", status: "queued", created_by: "system:sdlc" }),
    ]);
    expect(steps[0].run_id).toBeTruthy();

    const keyOf = (artifactId: string) => item.artifacts.find((a) => a.artifactId === artifactId)?.docKey ?? "";
    await baseline(keyOf("spec"), "# Spec\n");
    let now = await detail(item.id);
    expect(now.phases[0]).toMatchObject({ id: "specify", status: "drafting", requiredApproved: 1, requiredTotal: 2 });
    const spec = now.artifacts.find((a) => a.artifactId === "spec");
    expect(spec).toMatchObject({
      baselineVersion: 1,
      approval: "human",
      syncs: [expect.objectContaining({ state: "pending" })],
    });
    const { rows: hashes } = await admin.query("select baseline_hash from hive.sdlc_artifacts where doc_key = $1", [
      keyOf("spec"),
    ]);
    expect(hashes[0].baseline_hash).toBe(createHash("sha256").update("# Spec\n").digest("hex"));

    await baseline(keyOf("glossary"), "# Thuật ngữ\n");
    now = await detail(item.id);
    expect(now.phases.map((p) => [p.id, p.status])).toEqual([
      ["specify", "approved"],
      ["plan", "skipped"],
      ["tasks", "drafting"],
      ["implement", "pending"],
      ["converge", "pending"],
    ]);
    expect(now.phases[0]?.approvedAt).toBeTruthy();
    expect(now.artifacts.find((a) => a.artifactId === "notes")?.baselineVersion).toBeNull();
    expect(now.phase).toMatchObject({ id: "tasks", index: 2 });
    expect(started.map((s) => s.step.id)).toEqual(["draft-spec", "draft-tasks"]);

    expect(await auditOf("sdlc.artifact.baseline", item.id)).toHaveLength(2);
    expect((await auditOf("sdlc.step.start", item.id)).map((d) => d.stepId)).toEqual(["draft-spec", "draft-tasks"]);
  });

  it("tài liệu không thuộc hạng mục thì bỏ qua; tự duyệt và duyệt lại ghi đúng cách có baseline; repo `off` không chờ đồng bộ", async () => {
    await as("tadmin", (tx) =>
      onBaseline(
        tx,
        { docKey: `project/${projectKey}/khac`, version: 1, proposalId: randomUUID(), reviewId: randomUUID() },
        deps,
      ),
    );
    const item = await create("tmember");
    await admin.query(
      `update hive.sdlc_item_projects set settings = jsonb_set(settings, '{repoSync}', '"off"') where item_id = $1`,
      [item.id],
    );
    const key = item.artifacts.find((a) => a.artifactId === "spec")?.docKey ?? "";
    await baseline(key, "# Spec\n", { autoApproved: true });
    let spec = (await detail(item.id)).artifacts.find((a) => a.artifactId === "spec");
    expect(spec).toMatchObject({ approval: "auto", syncs: [expect.objectContaining({ state: "none" })] });

    await as("tadmin", (tx) =>
      onBaseline(
        tx,
        { docKey: key, version: 1, proposalId: randomUUID(), reviewId: randomUUID(), reaffirm: true },
        deps,
      ),
    );
    spec = (await detail(item.id)).artifacts.find((a) => a.artifactId === "spec");
    expect(spec).toMatchObject({ approval: "reaffirmed", baselineVersion: 1 });
  });

  it("triển khai không tự đạt; đạt từ bên ngoài thì hạng mục xong, có audit", async () => {
    const item = await create("tmember", { modeRef: "bugfix", size: "S", title: "Sửa lỗi tính thuế" });
    await baseline(item.artifacts[0]?.docKey ?? "", "# Lỗi\n");
    let now = await detail(item.id);
    expect(now.phase).toMatchObject({ id: "implement", status: "drafting" });
    await as("tadmin", (tx) => advance(tx, item.id, deps));
    expect((await detail(item.id)).phase?.id).toBe("implement");

    await as("tadmin", (tx) => approvePhase(tx, item.id, "implement", deps));
    now = await detail(item.id);
    expect(now).toMatchObject({ status: "done", phase: null });
    expect(now.phases.map((p) => p.status)).toEqual(["approved", "approved"]);
    expect(await auditOf("sdlc.item.done", item.id)).toHaveLength(1);
  });
});

describe("bỏ qua giai đoạn", () => {
  it("chỉ giai đoạn tuỳ chọn, cần lý do, chủ hoặc quản trị đội; có audit", async () => {
    const item = await create("tmember");
    const skip = (who: string, phaseId: string, reason: string) =>
      as(who, (tx) => skipPhase(tx, org.user(who), { id: item.id, phaseId, reason }, deps));

    expect(await errorCode(() => skip("tmember", "converge", "  "))).toBe("SDLC_SKIP_REASON");
    expect(await errorCode(() => skip("tmember", "specify", "Không cần"))).toBe("SDLC_PHASE_NOT_OPTIONAL");
    expect(await errorCode(() => skip("tviewer", "converge", "Không cần"))).toBe("SDLC_MANAGE_FORBIDDEN");
    expect(await errorCode(() => skip("oadmin", "converge", "Không cần"))).toBe("SDLC_ITEM_NOT_FOUND");

    await skip("tadmin", "converge", "Việc nhỏ, không cần hội tụ");
    const now = await detail(item.id);
    expect(now.phases.find((p) => p.id === "converge")).toMatchObject({
      status: "skipped",
      note: "Việc nhỏ, không cần hội tụ",
    });
    expect(now.phase?.id).toBe("specify");
    expect(await errorCode(() => skip("tadmin", "converge", "Lần nữa"))).toBe("SDLC_PHASE_CLOSED");
    expect(await auditOf("sdlc.phase.skip", item.id)).toEqual([
      { phaseId: "converge", reason: "Việc nhỏ, không cần hội tụ" },
    ]);
  });
});

describe("workflowFor", () => {
  it("dựng quy trình từ cổng của giai đoạn chứa tài liệu; key ngoài hạng mục trả null", async () => {
    const item = await create("tmember", { modeRef: "speckit" });
    const plan = item.artifacts.find((a) => a.artifactId === "plan")?.docKey ?? "";
    const wf = await as("tviewer", (tx) => workflowFor(tx, plan));
    expect(wf?.name).toBe("001 · Plan");
    expect(wf?.phases).toEqual(speckit.phases.find((p) => p.id === "plan")?.gate);
    expect(await as("tviewer", (tx) => workflowFor(tx, `project/${projectKey}/docs/khac`))).toBeNull();
  });
});

describe("cổng theo đội (D21)", () => {
  const web: string[] = [];

  beforeAll(async () => {
    // Hai dự án của đội crm (seedOrg) tham gia hạng mục ở dự án của đội thanh-toan.
    for (const k of ["w", "wz"])
      web.push(
        (
          await seedProject(admin, app, {
            orgId: org.orgId,
            teamId: org.otherTeamId,
            systemId: org.otherSystemId,
            adminUserId: org.user("admin"),
            masterKey,
            key: `${k}${tag}`,
            settings: { ...defaultProjectSettings(), sdlc: projectSdlcSettings.parse({ enabled: true }) },
          })
        ).projectId,
      );
  });

  const multi = () => create("admin", { modeRef: "speckit", participants: web });

  it("itemTeams gộp dự án cùng đội, đội chủ trì trước", async () => {
    const item = await multi();
    const teams = await as("admin", (tx) => itemTeams(tx, item.id));
    expect(teams.map((t) => [t.teamId, t.projects.map((x) => x.key)])).toEqual([
      [org.teamId, [projectKey]],
      [org.otherTeamId, [`w${tag}`, `wz${tag}`]],
    ]);
  });

  it("workflowFor nhân checkpoint trong perProjectGates thành một checkpoint mỗi đội, roles tính trong đội đó", async () => {
    const item = await multi();
    const tasks = item.artifacts.find((a) => a.artifactId === "tasks")?.docKey ?? "";
    const wf = await as("tviewer", (tx) => workflowFor(tx, tasks));
    const gates = wf?.phases.flatMap((p) => p.gates) ?? [];
    expect(gates.map((g) => g.id)).toEqual(["rules", "ai-tasks", "lead-thanh-toan", "lead-crm"]);
    const crm = gates.find((g) => g.id === "lead-crm");
    expect(crm?.name).toBe(`Tech lead duyệt bản tách · crm (w${tag}, wz${tag})`);
    expect(crm?.reviewers).toMatchObject({ roles: ["team-admin"], quorum: 1, teamScope: org.otherTeamId });
    expect(gates.find((g) => g.id === "lead-thanh-toan")?.reviewers?.teamScope).toBe(org.teamId);
    // Checkpoint không nằm trong perProjectGates giữ nguyên; quy trình vẫn hợp lệ với schema của spec 004.
    expect(gates.find((g) => g.id === "ai-tasks")?.reviewers).toBeUndefined();
    for (const p of wf?.phases ?? []) expect(reviewPhase.safeParse(p).success).toBe(true);
  });

  it("dự án tham gia đã bỏ thì phiên mở sau không còn checkpoint của đội đó", async () => {
    const item = await multi();
    await admin.query("update hive.sdlc_item_projects set removed_at = now() where item_id = $1 and role <> 'home'", [
      item.id,
    ]);
    const tasks = item.artifacts.find((a) => a.artifactId === "tasks")?.docKey ?? "";
    const wf = await as("admin", (tx) => workflowFor(tx, tasks));
    expect(wf?.phases).toEqual(speckit.phases.find((p) => p.id === "tasks")?.gate);
  });

  it("id checkpoint quá dài thì dùng số thứ tự đội", () => {
    const phases: ReviewPhase[] = [
      reviewPhase.parse({
        name: "Duyệt",
        gates: [{ id: "tech-lead", name: "Tech lead", kind: "human", reviewers: { roles: ["team-admin"] } }],
      }),
    ];
    const teams: ItemTeam[] = [
      { teamId: randomUUID(), slug: "a", name: "A", projects: [{ id: randomUUID(), key: "pa", name: "" }] },
      {
        teamId: randomUUID(),
        slug: "doi-co-ten-rat-dai-vuot-gioi-han",
        name: "Dài",
        projects: [{ id: randomUUID(), key: "pb", name: "" }],
      },
    ];
    const [phase] = expandPerProjectGates(phases, ["tech-lead"], teams);
    expect(phase?.gates.map((g) => g.id)).toEqual(["tech-lead-a", "tech-lead-2"]);
  });
});
