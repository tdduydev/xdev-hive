import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { McpToolRegistry } from "../mcp/index.ts";
import { createPool, type Jobs, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import { createItem } from "./items.ts";
import { handleSdlcJob } from "./jobs.ts";
import { registerMcpTools } from "./mcp-tools.ts";
import { advance, type SdlcDeps, type SdlcJob, type SdlcRunRequest } from "./phases.ts";
import { runStep, withStepRuns } from "./steps.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
const home = { id: "", key: "", owner: "", repo: "" };
let scm: MemoryProvider;
let requests: SdlcRunRequest[] = [];
let enqueued: SdlcJob[] = [];
let deps: SdlcDeps;
let seq = 0;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const system = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

const registry = new McpToolRegistry();
registerMcpTools(registry);
const report = (runId: string, kind: string, data: Record<string, unknown>) => {
  const tool = registry.list().find((t) => t.name === "sdlc_report");
  if (!tool) throw new Error("thiếu tool sdlc_report");
  const principal = {
    kind: "run" as const,
    userId: "run",
    runId,
    runKind: "sdlc",
    projectId: home.id,
    attempt: 1,
    scopes: [],
  };
  return system((tx) =>
    tool.handler(tool.input.parse({ kind, data }), { tx, orgId: org.orgId, principal }, undefined),
  ) as Promise<Record<string, unknown>>;
};

beforeAll(async () => {
  org = await seedOrg(admin, `rel-${tag}`);
  scm = createMemoryProvider("gitlab", ["xdev-team"]);
  const key = `pay${tag}`;
  const seeded = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
    settings: {
      ...defaultProjectSettings(),
      sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit", modes: ["speckit"] }),
    },
  });
  Object.assign(home, { id: seeded.projectId, key, owner: seeded.owner, repo: seeded.repo });
  scm.seedRepo({ owner: seeded.owner, name: seeded.repo }, { files: { "README.md": `# ${key}` } });
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
  enqueued = [];
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

/** Task đã merge của hạng mục: liên kết `pr` và `commit` như khi run code kết luận và PR merge. */
async function mergedTask(itemId: string, n: number, requirementId: string) {
  const { rows } = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, status, created_by)
     values ($1, $2, $3, $4, $5, $6, 'done', 'seed') returning id`,
    [org.orgId, org.teamId, home.id, 100 + ++seq, `R${tag}-${seq}`, `Việc ${n}`],
  );
  const taskId = rows[0].id as string;
  await admin.query(
    `insert into hive.sdlc_item_tasks (org_id, item_id, task_id, project_id, slice_key, wave, breakdown_version, requirement_ids)
     values ($1, $2, $3, $4, $5, 1, 1, $6)`,
    [org.orgId, itemId, taskId, home.id, `T00${n}`, [requirementId]],
  );
  for (const [kind, ref] of [
    ["pr", `https://gitlab.com/${home.owner}/${home.repo}/-/merge_requests/${n}`],
    ["commit", `${n}abcdef0123456789`],
  ])
    await admin.query(
      `insert into hive.sdlc_trace_links (org_id, item_id, requirement_id, kind, ref, project_id, task_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [org.orgId, itemId, requirementId, kind, ref, home.id, taskId],
    );
}

/** Hạng mục speckit có issue nguồn, 3 PR đã merge, vừa hội tụ: giai đoạn release bắt đầu. */
async function atRelease() {
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
        issueUrl: `https://gitlab.com/${home.owner}/${home.repo}/-/issues/7`,
      },
      deps,
    ),
  );
  for (const [n, fr] of [
    [1, "FR-001"],
    [2, "FR-002"],
    [3, "FR-003"],
  ] as const)
    await mergedTask(item.id, n, fr);
  await admin.query("update hive.sdlc_steps set status = 'succeeded' where item_id = $1", [item.id]);
  await admin.query(
    `update hive.sdlc_item_phases set status = case when phase_id = 'release' then 'pending' else 'approved' end,
       started_at = now() - interval '2 hours', approved_at = now() where item_id = $1`,
    [item.id],
  );
  await admin.query(
    "update hive.sdlc_items set phase_index = 4, converged_at = now(), converge_round = 1 where id = $1",
    [item.id],
  );
  requests = [];
  await system((tx) => advance(tx, item.id, deps));
  return item;
}

const itemRow = async (id: string) =>
  (await admin.query("select status, phase_index from hive.sdlc_items where id = $1", [id])).rows[0];
const stepRow = async (itemId: string, stepId: string) =>
  (await admin.query("select * from hive.sdlc_steps where item_id = $1 and step_id = $2", [itemId, stepId])).rows[0];

describe("release notes và retro (US11)", () => {
  it("hội tụ xong thì bước release-notes tự chạy với dữ liệu phát hành của hub", async () => {
    const item = await atRelease();
    expect(await itemRow(item.id)).toMatchObject({ status: "active", phase_index: 5 });
    expect(requests).toHaveLength(1);
    const run = requests[0] as SdlcRunRequest;
    expect(run.title).toContain("release-notes");
    expect(run.prompt).toContain("Dữ liệu phát hành của hub");
    expect(run.prompt).toContain("`.hive/sdlc/release.md`");
    expect(run.job.collect.map((c) => c.path)).toEqual([`specs/${item.ref}-${item.slug}/release-notes.md`]);

    const brief = run.job.seed.find((s) => s.path === ".hive/sdlc/release.md")?.content ?? "";
    const prs = brief.split("\n").filter((l) => l.includes("merge_requests/"));
    expect(prs).toHaveLength(3);
    expect(prs[0]).toBe(
      `- ${home.key} R${tag}-1 · Việc 1 · FR-001 · https://gitlab.com/${home.owner}/${home.repo}/-/merge_requests/1 · merge 1abcdef`,
    );
    expect(brief).toContain("3 requirement · kế hoạch 100% · đã làm 100%");
    expect(brief).toContain("| Specify | approved | 2.0 giờ | 0 |");
    expect(brief).toContain("Số vòng converge: 1 (đã hội tụ)");
  });

  it("retro báo bài học thành đề xuất tạo constitution mới; key ngoài hạng mục và bước khác bị từ chối", async () => {
    const item = await atRelease();
    const notesRun = (await stepRow(item.id, "release-notes")).run_id as string;
    expect(
      await errorCode(() => report(notesRun, "lessons", { content: "# Constitution\n", reason: "Học được" })),
    ).toBe("SDLC_REPORT_INVALID");

    await admin.query("update hive.sdlc_steps set status = 'succeeded' where item_id = $1", [item.id]);
    await as("tmember", (tx) =>
      runStep(tx, org.user("tmember"), { id: item.id, phaseId: "release", stepId: "retro" }, deps),
    );
    const retro = await stepRow(item.id, "retro");
    expect(requests.at(-1)?.prompt).toContain("`lessons`");

    expect(
      await errorCode(() =>
        report(retro.run_id, "lessons", { key: "project/khac/constitution", content: "x", reason: "Sai chỗ" }),
      ),
    ).toBe("SDLC_LESSONS_KEY");

    const content = "# Constitution\n\n- Mỗi FR phải có test tích hợp trước khi merge.\n";
    const out = await report(retro.run_id, "lessons", { content, reason: "Vòng converge 1 thiếu test" });
    expect(out).toMatchObject({ recorded: "lessons", key: `project/${home.key}/constitution`, baseVersion: 0 });
    const proposal = (
      await admin.query("select target, base_version, content, reason, status from hive.proposals where id = $1", [
        out.proposalId,
      ])
    ).rows[0];
    expect(proposal).toMatchObject({
      target: `project/${home.key}/constitution`,
      base_version: 0,
      content,
      reason: `Retro ${item.ref}: Vòng converge 1 thiếu test`,
      // Key không có quy trình duyệt riêng thì là đề xuất thường, chờ người có quyền duyệt như đề xuất khác.
      status: "pending",
    });
    expect((await stepRow(item.id, "retro")).result.lessons).toMatchObject({ proposalId: out.proposalId });
  });

  it("đóng hạng mục thì bình luận issue nguồn: tóm tắt và link release notes", async () => {
    const item = await atRelease();
    await admin.query(
      "update hive.sdlc_artifacts set baseline_version = 1 where item_id = $1 and phase_id = 'release'",
      [item.id],
    );
    const jobs = {
      enqueue: async (_queue: string, data: SdlcJob) => {
        enqueued.push(data);
        return randomUUID();
      },
    } as unknown as Jobs;
    await system((tx) => advance(tx, item.id, { ...deps, jobs }));
    expect(await itemRow(item.id)).toMatchObject({ status: "done" });
    const job = enqueued.find((j) => j.kind === "issue-comment");
    expect(job).toEqual({ kind: "issue-comment", orgId: org.orgId, itemId: item.id, event: "done" });

    await handleSdlcJob(
      { pool: app, providerFactory: () => scm, masterKey, publicUrl: "https://hive.test" },
      job as SdlcJob,
    );
    const comments = scm.repos.get(`${home.owner}/${home.repo}`.toLowerCase())?.comments ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.number).toBe(7);
    expect(comments[0]?.body).toContain(`${item.ref} “Hoàn tiền một phần” đã xong`);
    expect(comments[0]?.body).toContain("3 PR đã merge; 3 requirement, đã làm 100%");
    expect(comments[0]?.body).toContain(
      `https://gitlab.com/${home.owner}/${home.repo}/-/blob/main/specs/${item.ref}-${item.slug}/release-notes.md`,
    );
  });
});
