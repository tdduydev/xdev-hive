import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings, type SdlcItemCreate } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { McpToolRegistry } from "../mcp/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider } from "../scm/index.ts";
import { SDLC_CONVERGE_ACTOR } from "./converge.ts";
import { createItem } from "./items.ts";
import { registerMcpTools } from "./mcp-tools.ts";
import { advance, type SdlcDeps, type SdlcRunRequest } from "./phases.ts";
import { onSdlcRunFinished, runStep, withStepRuns } from "./steps.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
const home = { id: "", key: "" };
const web = { id: "", key: "" };
let requests: SdlcRunRequest[] = [];
let deps: SdlcDeps;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const system = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

const registry = new McpToolRegistry();
registerMcpTools(registry);
const report = (runId: string, projectId: string, findings: Record<string, unknown>[]) => {
  const tool = registry.list().find((t) => t.name === "sdlc_report");
  if (!tool) throw new Error("thiếu tool sdlc_report");
  const principal = { kind: "run" as const, userId: "run", runId, runKind: "sdlc", projectId, attempt: 1, scopes: [] };
  return system((tx) =>
    tool.handler(
      tool.input.parse({ kind: "findings", data: { findings } }),
      { tx, orgId: org.orgId, principal },
      undefined,
    ),
  );
};
const finish = (runId: string) =>
  system((tx) => onSdlcRunFinished(tx, { runId, ok: true, artifacts: [], error: null }, deps));

beforeAll(async () => {
  org = await seedOrg(admin, `cvg-${tag}`);
  const scm = createMemoryProvider("gitlab", ["xdev-team"]);
  for (const [p, key, labels] of [
    [home, `api${tag}`, ["sdlc"]],
    [web, `web${tag}`, ["web-runner"]],
  ] as const) {
    const seeded = await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key,
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({
          enabled: true,
          defaultMode: "speckit",
          modes: ["speckit"],
          labels: [...labels],
        }),
      },
    });
    p.id = seeded.projectId;
    p.key = key;
    scm.seedRepo({ owner: seeded.owner, name: seeded.repo }, { files: { "README.md": `# ${key}` } });
  }
  deps = withStepRuns({
    providerFactory: () => scm,
    masterKey,
    createSdlcRun: async (_tx, request) => {
      requests.push(request);
      return { runId: randomUUID() };
    },
  });
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  requests = [];
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

/** Hạng mục speckit đã xong triển khai: giai đoạn converge bắt đầu và tự chạy vòng 1; release sau đó còn chờ. */
async function atConverge(over: Partial<SdlcItemCreate> = {}) {
  const item = await as("tmember", (tx) =>
    createItem(
      tx,
      org.user("tmember"),
      {
        projectId: home.id,
        title: "Hoàn tiền một phần",
        idea: "Cho phép hoàn tiền một phần cho đơn đã thanh toán, có ghi lý do và lịch sử.",
        modeRef: "speckit",
        size: "M",
        ...over,
      },
      deps,
    ),
  );
  await admin.query("update hive.sdlc_steps set status = 'succeeded' where item_id = $1", [item.id]);
  await admin.query(
    `update hive.sdlc_item_phases set status = case when phase_id in ('converge', 'release') then 'pending' else 'approved' end
      where item_id = $1`,
    [item.id],
  );
  await admin.query("update hive.sdlc_items set phase_index = 3 where id = $1", [item.id]);
  requests = [];
  await system((tx) => advance(tx, item.id, deps));
  return item;
}

const convergeRows = async (itemId: string) =>
  (
    await admin.query(
      "select * from hive.sdlc_steps where item_id = $1 and action = 'converge' order by round, created_at",
      [itemId],
    )
  ).rows;
const itemRow = async (id: string) =>
  (
    await admin.query("select status, phase_index, converge_round, converged_at from hive.sdlc_items where id = $1", [
      id,
    ])
  ).rows[0];
const convergePhase = async (itemId: string) =>
  (
    await admin.query("select status, note from hive.sdlc_item_phases where item_id = $1 and phase_id = 'converge'", [
      itemId,
    ])
  ).rows[0];
const runConverge = (itemId: string) =>
  as("tmember", (tx) =>
    runStep(tx, org.user("tmember"), { id: itemId, phaseId: "converge", stepId: "converge-spec" }, deps),
  );

describe("converge theo dự án (US10)", () => {
  it("một run mỗi dự án cùng vòng; gộp phát hiện; còn thiếu → bước soạn tasks; vòng 2 đạt hết → hội tụ, hạng mục xong", async () => {
    const item = await atConverge({ participants: [web.id] });
    expect(await itemRow(item.id)).toMatchObject({ phase_index: 4, converge_round: 1, converged_at: null });
    const [api, wb] = await convergeRows(item.id);
    expect([api?.round, wb?.round]).toEqual([1, 1]);
    expect(requests.map((r) => [r.projectId, r.requiredLabels])).toEqual([
      [home.id, ["sdlc"]],
      [web.id, ["web-runner"]],
    ]);
    const webRun = requests[1] as SdlcRunRequest;
    expect(webRun.title).toMatch(new RegExp(`converge-spec · ${web.key}$`));
    expect(webRun.prompt).toContain(`Repo của worktree này: ${web.key}`);
    // Bước đọc chéo không thu file; tài liệu dự án chính nằm dưới thư mục seed vì worktree là repo của web.
    expect(webRun.job.collect).toEqual([]);
    expect(webRun.job.seed.some((s) => s.path.startsWith(`.hive/sdlc/${home.key}/`))).toBe(true);

    await report(api.run_id, home.id, [
      { requirementId: "FR-001", status: "met", evidence: "refund.ts:12, refund.test.ts" },
      { requirementId: "FR-002", status: "missing", evidence: "Không thấy lịch sử", suggestedTask: "Lưu lịch sử hoàn" },
    ]);
    await report(wb.run_id, web.id, [
      { requirementId: "FR-001", status: "met", evidence: "RefundForm.tsx" },
      { requirementId: "FR-003", status: "contradicts", evidence: "Form cho hoàn quá số tiền", suggestedTask: "Chặn" },
    ]);
    const [reported] = await convergeRows(item.id);
    expect(reported.result.findings).toEqual([
      expect.objectContaining({ requirementId: "FR-001", status: "met", projectId: home.id }),
      expect.objectContaining({ requirementId: "FR-002", status: "missing", projectId: home.id }),
    ]);

    expect((await finish(api.run_id))?.message).toContain("còn 1 run chưa xong");
    const done = await finish(wb.run_id);
    expect(done?.message).toContain("còn 2 yêu cầu chưa đạt");
    expect(done?.message).toContain("Đã giao agent bổ sung task");

    const links = await admin.query(
      "select requirement_id, project_id, data from hive.sdlc_trace_links where item_id = $1 and kind = 'finding' order by requirement_id, project_id",
      [item.id],
    );
    expect(links.rows.map((l) => [l.requirement_id, l.project_id === web.id ? "web" : "api", l.data.status])).toEqual(
      expect.arrayContaining([
        ["FR-001", "api", "met"],
        ["FR-001", "web", "met"],
        ["FR-002", "api", "missing"],
        ["FR-003", "web", "contradicts"],
      ]),
    );
    expect(links.rows).toHaveLength(4);
    expect(links.rows[0]?.data).toMatchObject({ round: 1, evidence: expect.any(String) });

    const follow = (
      await admin.query(
        "select phase_id, step_id, created_by, instructions, status from hive.sdlc_steps where item_id = $1 and phase_id = 'tasks' and created_by = $2",
        [item.id, SDLC_CONVERGE_ACTOR],
      )
    ).rows;
    expect(follow).toHaveLength(1);
    expect(follow[0]).toMatchObject({ step_id: "draft-tasks", status: "running" });
    expect(follow[0].instructions).toContain(
      `FR-003 · contradicts · @${web.key}: Form cho hoàn quá số tiền Đề xuất: Chặn`,
    );
    expect(follow[0].instructions).toContain(`FR-002 · missing · @${home.key}`);
    expect(follow[0].instructions).not.toContain("FR-001");
    expect(follow[0].instructions).toContain("Sửa tài liệu");
    expect(await convergePhase(item.id)).toMatchObject({
      status: "drafting",
      note: expect.stringContaining("2 yêu cầu"),
    });
    expect(await itemRow(item.id)).toMatchObject({ phase_index: 4, converged_at: null });

    // Vòng 2 do người bấm; mọi dự án đạt hết thì hội tụ, giai đoạn đạt và hạng mục sang release (US11).
    requests = [];
    await runConverge(item.id);
    const round2 = (await convergeRows(item.id)).filter((r) => r.round === 2);
    expect(round2).toHaveLength(2);
    expect(requests.map((r) => r.projectId)).toEqual([home.id, web.id]);
    for (const [row, projectId] of [
      [round2[0], home.id],
      [round2[1], web.id],
    ] as const)
      await report(row.run_id, projectId, [{ requirementId: "FR-002", status: "met", evidence: "history.ts" }]);
    await finish(round2[0].run_id);
    expect((await finish(round2[1].run_id))?.message).toContain("Đã hội tụ ở vòng 2");
    expect(await itemRow(item.id)).toMatchObject({
      status: "active",
      phase_index: 5,
      converge_round: 2,
      converged_at: expect.any(Date),
    });
    expect(requests.at(-1)?.title).toContain("release-notes");
    expect(await convergePhase(item.id)).toMatchObject({ status: "approved", note: null });
    const inbox = await admin.query("select title from hive.inbox_items where org_id = $1 and user_id = $2", [
      org.orgId,
      org.user("tmember"),
    ]);
    expect(inbox.rows.map((r) => r.title)).toContain(`Hạng mục ${item.ref} đã hội tụ`);
  });

  it("run không báo phát hiện thì lỗi; hết vòng còn thiếu thì dừng, báo chủ, không cho vòng mới", async () => {
    const item = await atConverge();
    const [first] = await convergeRows(item.id);
    expect((await finish(first.run_id))?.succeeded).toBe(false);
    expect((await convergeRows(item.id))[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("sdlc_report loại findings"),
    });
    expect(await convergePhase(item.id)).toMatchObject({
      status: "drafting",
      note: expect.stringContaining("run lỗi"),
    });

    await runConverge(item.id);
    const second = (await convergeRows(item.id))[1];
    expect(second.round).toBe(2);
    await report(second.run_id, home.id, [{ requirementId: "FR-001", status: "partial", evidence: "Thiếu lý do" }]);
    expect((await finish(second.run_id))?.message).toContain("Hết 2 vòng converge");
    expect(await convergePhase(item.id)).toMatchObject({
      status: "drafting",
      note: expect.stringContaining("Hết 2 vòng"),
    });
    const follow = await admin.query("select 1 from hive.sdlc_steps where item_id = $1 and created_by = $2", [
      item.id,
      SDLC_CONVERGE_ACTOR,
    ]);
    expect(follow.rowCount).toBe(0);
    const inbox = await admin.query("select title from hive.inbox_items where org_id = $1 and title like $2", [
      org.orgId,
      `Hạng mục ${item.ref} chưa hội tụ%`,
    ]);
    expect(inbox.rowCount).toBe(1);
    expect(await errorCode(() => runConverge(item.id))).toBe("SDLC_CONVERGE_ROUNDS");
    expect(await itemRow(item.id)).toMatchObject({ status: "active", converge_round: 2, converged_at: null });
  });

  it("đã hội tụ thì không chạy converge nữa", async () => {
    const item = await atConverge();
    await admin.query("update hive.sdlc_items set converged_at = now() where id = $1", [item.id]);
    expect(await errorCode(() => runConverge(item.id))).toBe("SDLC_CONVERGED");
  });
});
