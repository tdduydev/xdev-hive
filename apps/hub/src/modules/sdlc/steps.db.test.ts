import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  defaultProjectSettings,
  projectSdlcSettings,
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
import { editorState } from "../knowledge/index.ts";
import { McpToolRegistry } from "../mcp/registry.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createMemoryProvider, type MemoryProvider } from "../scm/index.ts";
import { createItem, getItem } from "./items.ts";
import { registerMcpTools } from "./mcp-tools.ts";
import { saveMode } from "./modes.ts";
import type { SdlcDeps, SdlcRunRequest } from "./phases.ts";
import { answerQuestions, askQuestions } from "./questions.ts";
import { onSdlcRunFinished, queueAuthorFix, runStep, withStepRuns } from "./steps.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const autoMode = `auto-${tag}`;

let org: OrgFixture & { user: (n: string) => string };
const home = { id: "", key: "" };
const web = { id: "", key: "" };
let scm: MemoryProvider;
let requests: SdlcRunRequest[] = [];
let deps: SdlcDeps;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
/** Như job hay `runs.verify`: không có người dùng trong context. */
const system = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: org.orgId }, fn);

const sdlcOn = (over: Record<string, unknown> = {}) =>
  projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit", modes: ["speckit", autoMode], ...over });

beforeAll(async () => {
  org = await seedOrg(admin, `sds-${tag}`);
  scm = createMemoryProvider("gitlab", ["xdev-team"]);
  for (const [p, key, settings] of [
    [home, `api${tag}`, sdlcOn({ labels: ["sdlc"], runner: "requester" })],
    [web, `web${tag}`, sdlcOn()],
  ] as const) {
    const seeded = await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key,
      settings: { ...defaultProjectSettings(), sdlc: settings },
    });
    p.id = seeded.projectId;
    p.key = key;
    scm.seedRepo(
      { owner: seeded.owner, name: seeded.repo },
      { files: { "README.md": `# ${key}\nRepo của ${key}.`, "package.json": `{"name":"${key}"}` } },
    );
  }
  deps = withStepRuns({
    providerFactory: () => scm,
    masterKey,
    createSdlcRun: async (_tx, request) => {
      requests.push(request);
      return { runId: randomUUID() };
    },
  });
  // Chế độ một giai đoạn Specify, agent tự gửi duyệt, cổng chỉ có người duyệt.
  const speckit = SDLC_PRESETS.speckit as SdlcMode;
  const m = structuredClone(speckit);
  m.id = autoMode;
  m.name = "Tự gửi duyệt";
  const specify = m.phases[0];
  const step = specify?.steps[0];
  if (!specify || !step) throw new Error("speckit đổi cấu trúc");
  step.autoSubmit = true;
  specify.gate = [
    reviewPhase.parse({
      name: "Duyệt spec",
      outputs: ["spec.md"],
      gates: [
        {
          id: "po",
          name: "PO duyệt",
          kind: "human",
          reviewers: { users: [], roles: ["team-admin"], teams: [], quorum: 1 },
          slaHours: 24,
        },
      ],
    }),
  ];
  await as("tadmin", (tx) =>
    saveMode(tx, org.user("tadmin"), {
      teamId: org.teamId,
      slug: autoMode,
      basePreset: "speckit",
      definition: sdlcMode.parse(m),
    }),
  );
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.doc_drafts where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.docs where org_id = $1", [org.orgId]);
  requests = [];
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const create = (over: Partial<SdlcItemCreate> = {}) =>
  as("tmember", (tx) =>
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

const stepRows = async (itemId: string) =>
  (await admin.query("select * from hive.sdlc_steps where item_id = $1 order by created_at", [itemId])).rows;
const phaseStatus = async (itemId: string, phaseId = "specify") =>
  (
    await admin.query("select status, note from hive.sdlc_item_phases where item_id = $1 and phase_id = $2", [
      itemId,
      phaseId,
    ])
  ).rows[0];

function artifactOf(request: SdlcRunRequest | undefined, content: string) {
  const c = request?.job.collect[0];
  if (!c) throw new Error("bước không có collect");
  return {
    artifactId: c.artifactId,
    path: c.path,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

describe("bước agent tạo run sdlc", () => {
  it("giai đoạn đầu tự chạy bước soạn: prompt, seed khuôn, collect, nhãn và chủ theo dự án chính", async () => {
    const item = await create();
    const [row] = await stepRows(item.id);
    expect(row).toMatchObject({ step_id: "draft-spec", status: "running", round: 1 });
    expect(requests).toHaveLength(1);
    const r = requests[0] as SdlcRunRequest;
    const ref = String(item.number).padStart(3, "0");
    const path = `specs/${ref}-${item.slug}/spec.md`;
    expect(r).toMatchObject({
      itemId: item.id,
      projectId: home.id,
      stepRowId: row.id,
      requiredLabels: ["sdlc"],
      // runner = requester: hub tự chạy bước thì chủ là chủ hạng mục.
      ownerUserId: org.user("tmember"),
      createdBy: "system:sdlc",
    });
    expect(r.job.collect).toEqual([{ artifactId: expect.any(String), path }]);
    expect(r.job.seed.find((s) => s.path === path)?.content).toContain("## ");
    expect(r.prompt).toContain("Cho phép hoàn tiền một phần");
    expect(r.prompt).toContain(`- spec.md → \`${path}\``);
    expect(row.run_id).toBeTruthy();
  });

  it("hạng mục nhiều dự án: seed tóm tắt repo tham gia", async () => {
    await create({ participants: [web.id] });
    const r = requests[0] as SdlcRunRequest;
    const digest = r.job.seed.find((s) => s.path === `.hive/sdlc/projects/${web.key}.md`);
    expect(digest?.content).toContain(`Repo của ${web.key}.`);
    expect(r.prompt).toContain(`- ${web.key}: tóm tắt repo ở \`.hive/sdlc/projects/${web.key}.md\``);
  });
});

describe("kết luận run sdlc", () => {
  it("agent hỏi 7 câu → nhận 5, giai đoạn chờ trả lời; trả lời đủ → lượt 2 có câu trả lời; file → bản nháp", async () => {
    const item = await create();
    const [first] = await stepRows(item.id);
    const runId = first.run_id as string;
    const asked = await system((tx) =>
      askQuestions(tx, runId, {
        questions: Array.from({ length: 7 }, (_, i) => ({
          text: `Câu ${i + 1}?`,
          options: ["A", "B"],
          recommended: i === 0 ? "A" : undefined,
        })),
      }),
    );
    expect(asked).toMatchObject({ dropped: 2, limit: 5 });
    expect(asked.ids).toHaveLength(5);

    const out = await system((tx) => onSdlcRunFinished(tx, { runId, ok: true, artifacts: [], error: null }, deps));
    expect(out).toMatchObject({ succeeded: true });
    expect(out?.message).toContain("Agent hỏi 5 câu");
    expect(await phaseStatus(item.id)).toMatchObject({ status: "awaiting_answers" });
    const inbox = await admin.query(
      "select title from hive.inbox_items where org_id = $1 and event = 'sdlc.question' and user_id = $2",
      [org.orgId, org.user("tmember")],
    );
    expect(inbox.rows[0]?.title).toContain("Agent hỏi 5 câu");

    // Trả lời một phần: chưa chạy lượt mới.
    const [q1, ...rest] = asked.ids as [string, ...string[]];
    await as("tmember", (tx) =>
      answerQuestions(tx, org.user("tmember"), { itemId: item.id, answers: [{ id: q1, useRecommended: true }] }, deps),
    );
    expect(await stepRows(item.id)).toHaveLength(1);
    const answered = await as("tmember", (tx) =>
      answerQuestions(
        tx,
        org.user("tmember"),
        { itemId: item.id, answers: rest.map((id, i) => ({ id, answer: `Trả lời ${i + 2}` })) },
        deps,
      ),
    );
    expect(answered.every((q) => q.status === "answered")).toBe(true);
    const steps = await stepRows(item.id);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ step_id: "draft-spec", round: 2, status: "running" });
    expect(await phaseStatus(item.id)).toMatchObject({ status: "drafting" });
    const second = requests[1] as SdlcRunRequest;
    expect(second.prompt).toContain("1. Câu 1?\n   → A");
    expect(second.prompt).toContain("→ Trả lời 5");

    const content = "# Spec\n\n## Requirements\n\n- FR-001: Hoàn tiền một phần.\n";
    const t0 = Date.now();
    const done = await system((tx) =>
      onSdlcRunFinished(
        tx,
        { runId: steps[1].run_id, ok: true, artifacts: [artifactOf(second, content)], error: null },
        deps,
      ),
    );
    expect(done).toMatchObject({ succeeded: true, message: "Agent đã ghi 1 tài liệu vào bản nháp." });
    const key = item.artifacts.find((a) => a.artifactId === "spec")?.docKey as string;
    const state = await as("tmember", (tx) => editorState(tx, { kind: "user", userId: org.user("tmember") }, { key }));
    // SC-008: tài liệu agent ghi đọc được ngay trên hub khi run kết luận.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(state.draft.content).toBe(content);
    expect(state.draft.updatedBy).toMatchObject({ userId: null, runId: steps[1].run_id });
    const result = (await stepRows(item.id))[1].result;
    expect(result.artifacts).toEqual([expect.objectContaining({ docKey: key, sha256: expect.any(String) })]);
  });

  it("autoSubmit: bản nháp agent ghi được gửi duyệt, giai đoạn sang in_review", async () => {
    const item = await create({ modeRef: autoMode });
    const [row] = await stepRows(item.id);
    const content = "# Spec\n\n## Requirements\n\n- FR-001: Có.\n";
    const out = await system((tx) =>
      onSdlcRunFinished(
        tx,
        { runId: row.run_id, ok: true, artifacts: [artifactOf(requests[0], content)], error: null },
        deps,
      ),
    );
    expect(out?.message).toContain("Đã gửi duyệt.");
    expect(await phaseStatus(item.id)).toMatchObject({ status: "in_review" });
    const key = item.artifacts.find((a) => a.artifactId === "spec")?.docKey as string;
    const review = await admin.query("select status from hive.review_instances where org_id = $1 and doc_key = $2", [
      org.orgId,
      key,
    ]);
    expect(review.rows[0]?.status).toBe("in_review");
  });

  it("không file, không câu hỏi, hay worker lỗi → bước failed; run khác bước bị bỏ qua", async () => {
    const item = await create();
    const [row] = await stepRows(item.id);
    const out = await system((tx) =>
      onSdlcRunFinished(tx, { runId: row.run_id, ok: true, artifacts: [], error: null }, deps),
    );
    expect(out).toMatchObject({ succeeded: false });
    expect((await stepRows(item.id))[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("không ghi"),
    });
    expect(
      await system((tx) => onSdlcRunFinished(tx, { runId: randomUUID(), ok: true, artifacts: [], error: null }, deps)),
    ).toBeNull();

    // Người chạy lại bước với chỉ dẫn; lỗi của worker giữ nguyên lý do.
    await as("tmember", (tx) =>
      runStep(
        tx,
        org.user("tmember"),
        { id: item.id, phaseId: "specify", stepId: "draft-spec", instructions: "Ngắn gọn" },
        deps,
      ),
    );
    const again = (await stepRows(item.id))[1];
    expect(again).toMatchObject({ round: 2, instructions: "Ngắn gọn", created_by: org.user("tmember") });
    expect(requests[1]?.prompt).toContain("Ngắn gọn");
    // runner = requester: người bấm là chủ run.
    expect(requests[1]?.ownerUserId).toBe(org.user("tmember"));
    expect(
      await errorCode(() =>
        as("tmember", (tx) =>
          runStep(tx, org.user("tmember"), { id: item.id, phaseId: "specify", stepId: "draft-spec" }, deps),
        ),
      ),
    ).toBe("SDLC_STEP_RUNNING");
    await system((tx) =>
      onSdlcRunFinished(
        tx,
        { runId: again.run_id, ok: false, artifacts: null, error: "Tài liệu vượt giới hạn." },
        deps,
      ),
    );
    expect((await stepRows(item.id))[1]).toMatchObject({ status: "failed", error: "Tài liệu vượt giới hạn." });
    // Người xem không chạy được bước.
    expect(
      await errorCode(() =>
        as("tviewer", (tx) =>
          runStep(tx, org.user("tviewer"), { id: item.id, phaseId: "specify", stepId: "draft-spec" }, deps),
        ),
      ),
    ).toBe("SDLC_FORBIDDEN");
  });
});

describe("sửa theo góp ý", () => {
  it("trả về agent chạy lại bước soạn với góp ý, tối đa maxAgentRevisions lượt", async () => {
    const item = await create();
    const key = item.artifacts.find((a) => a.artifactId === "spec")?.docKey as string;
    const finish = async () => {
      const last = (await stepRows(item.id)).at(-1);
      await admin.query("update hive.sdlc_steps set status = 'succeeded' where id = $1", [last.id]);
    };
    const fix = (note: string) =>
      system((tx) =>
        queueAuthorFix(
          tx,
          { reviewId: randomUUID(), docKey: key, docTitle: "spec.md", projectId: home.id, note, decider: "u" },
          deps,
        ),
      );
    await finish();
    expect(await fix("Thiếu tiêu chí")).toBe(true);
    expect((await stepRows(item.id)).at(-1)).toMatchObject({ created_by: "system:sdlc-revise", round: 2 });
    expect(requests.at(-1)?.prompt).toContain("Người duyệt trả lại spec.md:\nThiếu tiêu chí");
    await finish();
    expect(await fix("Còn thiếu")).toBe(true);
    await finish();
    // Speckit cho tối đa 2 lượt agent sửa: lượt 3 về người viết.
    expect(await fix("Vẫn thiếu")).toBe(true);
    expect(await stepRows(item.id)).toHaveLength(3);
    expect((await phaseStatus(item.id)).note).toContain("người viết sửa tay");
    // Tài liệu ngoài hạng mục: knowledge làm như cũ.
    expect(
      await system((tx) =>
        queueAuthorFix(
          tx,
          {
            reviewId: randomUUID(),
            docKey: "project/x/prd",
            docTitle: "PRD",
            projectId: null,
            note: "x",
            decider: null,
          },
          deps,
        ),
      ),
    ).toBe(false);
  });
});

describe("MCP sdlc_report và sdlc_context", () => {
  it("contracts thành bản nháp contract; size ghi vào kết quả bước; context chỉ thấy hạng mục của dự án run", async () => {
    const item = await create({ participants: [web.id] });
    const [row] = await stepRows(item.id);
    const registry = new McpToolRegistry();
    registerMcpTools(registry);
    const tool = (name: string) => {
      const t = registry.list().find((x) => x.name === name);
      if (!t) throw new Error(`thiếu tool ${name}`);
      return t;
    };
    const principal = {
      kind: "run" as const,
      userId: "run",
      runId: row.run_id as string,
      runKind: "sdlc",
      projectId: home.id,
      attempt: 1,
      scopes: [],
    };
    const call = (name: string, args: Record<string, unknown>, p = principal) =>
      system((tx) =>
        tool(name).handler(tool(name).input.parse(args), { tx, orgId: org.orgId, principal: p }, undefined),
      );

    const report = (await call("sdlc_report", {
      kind: "contracts",
      data: {
        contracts: [
          {
            name: "refund-api",
            format: "openapi",
            provider: home.key,
            consumers: [web.key],
            content: "openapi: 3.1.0\n",
          },
          { name: "la", format: "openapi", provider: "khong-co", consumers: [web.key], content: "x" },
        ],
      },
    })) as { created: string[]; rejected: { name: string }[] };
    expect(report.created).toHaveLength(1);
    expect(report.rejected.map((r) => r.name)).toEqual(["la"]);
    const contract = await admin.query(
      "select scope, instance, consumer_project_ids from hive.sdlc_artifacts where item_id = $1 and scope = 'contract'",
      [item.id],
    );
    expect(contract.rows[0]).toMatchObject({ instance: "refund-api", consumer_project_ids: [web.id] });

    await call("sdlc_report", { kind: "size", data: { size: "L", modeRef: "speckit", reason: "Nhiều module" } });
    const result = (await stepRows(item.id))[0].result;
    expect(result).toMatchObject({ size: { size: "L" }, contracts: { created: report.created } });
    expect(await errorCode(() => call("sdlc_report", { kind: "size", data: { size: "XXL" } }))).toBe(
      "SDLC_REPORT_INVALID",
    );

    const ctx = (await call("sdlc_context", {})) as {
      item: { id: string };
      projects: { key: string }[];
      contracts: unknown[];
    };
    expect(ctx.item.id).toBe(item.id);
    expect(ctx.projects.map((p) => p.key).sort()).toEqual([home.key, web.key].sort());
    expect(ctx.contracts).toHaveLength(1);
    // Run của dự án không tham gia không đọc được hạng mục (D22).
    const outsider = await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.otherTeamId,
      systemId: org.otherSystemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `ngoai${tag}`,
    });
    expect(
      await errorCode(() =>
        call("sdlc_context", { itemId: item.id }, { ...principal, runId: randomUUID(), projectId: outsider.projectId }),
      ),
    ).toBe("SDLC_ITEM_NOT_FOUND");

    // Item đã đọc lại vẫn đúng (route get dùng cùng dữ liệu).
    const detail = await as("tmember", (tx) => getItem(tx, org.user("tmember"), { id: item.id }));
    expect(detail.steps[0]?.result).toMatchObject({ size: { size: "L" } });
  });
});
