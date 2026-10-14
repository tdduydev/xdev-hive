import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultProjectSettings,
  projectSdlcSettings,
  SDLC_GATE_BLOCKED,
  SDLC_PRESETS,
  type SdlcBlocking,
  type SdlcMode,
  TASK_DEPENDENCIES_OPEN,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { codeRunGate } from "./gate.ts";
import { createOverride, listOverrides, revokeOverride } from "./overrides.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

const speckit = SDLC_PRESETS.speckit as SdlcMode;
const HOUR = 3_600_000;
const sdlcOn = (over: Record<string, unknown> = {}) => projectSdlcSettings.parse({ enabled: true, ...over });

let org: OrgFixture & { user: (n: string) => string };
/** web-shop và crm thuộc đội chính; api thuộc đội kia. */
const project = {} as Record<"web" | "api" | "crm", { id: string; key: string }>;
let taskNumber = 0;
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const gateOf = (taskId: string, now?: Date) => as("admin", (tx) => codeRunGate(tx, { taskId, kind: "code", now }));

beforeAll(async () => {
  org = await seedOrg(admin, `gate-${randomUUID().slice(0, 6)}`);
  const make = async (name: "web" | "api" | "crm", teamId: string, systemId: string) => {
    const key = `${name}-${randomUUID().slice(0, 4)}`;
    const { projectId } = await seedProject(admin, app, {
      orgId: org.orgId,
      teamId,
      systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key,
      settings: { ...defaultProjectSettings(), sdlc: sdlcOn() },
    });
    project[name] = { id: projectId, key };
  };
  await make("web", org.teamId, org.systemId);
  await make("crm", org.teamId, org.systemId);
  await make("api", org.otherTeamId, org.otherSystemId);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const one = async (q: string, p: unknown[]) => (await admin.query(q, p)).rows[0].id as string;

async function seedTask(projectId: string, teamId: string, status = "todo") {
  taskNumber += 1;
  const key = `${project.web.key}-t${taskNumber}`;
  return one(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, status, created_by)
     values ($1, $2, $3, $4, $5, $5, $6, 'u') returning id`,
    [org.orgId, teamId, projectId, 1000 + taskNumber, key, status],
  );
}

interface SeedOptions {
  /** Dự án tham gia ngoài dự án chính web. */
  participants?: ("api" | "crm")[];
  blocking?: SdlcBlocking;
  /** Id tài liệu chung đã có baseline. */
  approved?: string[];
}
const teamOf = (name: "web" | "api" | "crm") => (name === "api" ? org.otherTeamId : org.teamId);

/** Hạng mục Spec Kit với dòng tài liệu spec, plan, tasks cho mọi giai đoạn trước implementation. */
async function seedItem(opts: SeedOptions = {}) {
  const number = 500 + ++taskNumber;
  const mode = { ...speckit, blocking: opts.blocking ?? speckit.blocking };
  const itemId = await one(
    `insert into hive.sdlc_items (org_id, team_id, project_id, number, slug, title, idea, source, mode_ref, mode,
       settings, size, owner_user_id, created_by)
     values ($1, $2, $3, $4, 'hoan-tien', 'Hoàn tiền', 'Ý tưởng', '{"kind":"manual"}', 'speckit', $5, $6, 'M',
       $7, $7) returning id`,
    [
      org.orgId,
      org.teamId,
      project.web.id,
      number,
      JSON.stringify(mode),
      JSON.stringify(sdlcOn()),
      org.user("tmember"),
    ],
  );
  const members: ["web" | "api" | "crm", "home" | "participant"][] = [
    ["web", "home"],
    ...(opts.participants ?? []).map((n): ["api" | "crm", "participant"] => [n, "participant"]),
  ];
  for (const [name, role] of members) {
    await admin.query(
      `insert into hive.sdlc_item_projects (org_id, item_id, project_id, team_id, role, settings, added_by)
       values ($1, $2, $3, $4, $5, $6, 'u')`,
      [org.orgId, itemId, project[name].id, teamOf(name), role, JSON.stringify(sdlcOn())],
    );
  }
  for (const [index, phase] of mode.phases.entries()) {
    await admin.query(
      `insert into hive.sdlc_item_phases (org_id, item_id, phase_index, phase_id, kind) values ($1, $2, $3, $4, $5)`,
      [org.orgId, itemId, index, phase.id, phase.kind],
    );
  }
  const artifacts: Record<string, string> = {};
  for (const [phaseId, artifactId] of [
    ["specify", "spec"],
    ["plan", "plan"],
    ["tasks", "tasks"],
  ] as const) {
    const done = opts.approved?.includes(artifactId);
    artifacts[artifactId] = await one(
      `insert into hive.sdlc_artifacts (org_id, project_id, item_id, phase_id, artifact_id, required, doc_key, repo_path,
         baseline_version, approval)
       values ($1, $2, $3, $4, $5, true, $6, $7, $8, $9) returning id`,
      [
        org.orgId,
        project.web.id,
        itemId,
        phaseId,
        artifactId,
        `project/${project.web.key}/sdlc/${number}-hoan-tien/${artifactId}`,
        `specs/${number}-hoan-tien/${artifactId}.md`,
        done ? 1 : null,
        done ? "human" : "none",
      ],
    );
  }
  return { itemId, artifacts, number };
}

async function linkTask(itemId: string, taskId: string, projectId: string) {
  await admin.query(
    `insert into hive.sdlc_item_tasks (org_id, item_id, task_id, project_id, slice_key, wave, breakdown_version)
     values ($1, $2, $3, $4, $5, 1, 1)`,
    [org.orgId, itemId, taskId, projectId, `T${randomUUID().slice(0, 8)}`],
  );
}

/** Hạng mục có một task ở dự án web (mặc định) và các tài liệu đã duyệt tuỳ chọn. */
async function seedGated(opts: SeedOptions & { taskStatus?: string } = {}) {
  const item = await seedItem(opts);
  const taskId = await seedTask(project.web.id, org.teamId, opts.taskStatus);
  await linkTask(item.itemId, taskId, project.web.id);
  return { ...item, taskId };
}

const allDocs = ["spec", "plan", "tasks"];

describe("codeRunGate", () => {
  it("task không thuộc hạng mục thì cho qua (SC-011)", async () => {
    const taskId = await seedTask(project.web.id, org.teamId);
    expect(await gateOf(taskId)).toEqual({ block: false });
  });

  it("chỉ chặn run code; run review, plan, leader đi qua", async () => {
    const { taskId } = await seedGated();
    for (const kind of ["review", "plan", "leader", "doccheck"]) {
      expect(await as("admin", (tx) => codeRunGate(tx, { taskId, kind }))).toEqual({ block: false });
    }
    expect((await as("admin", (tx) => codeRunGate(tx, { taskId, kind: "code" }))).block).toBe(true);
  });

  it("chặn cứng khi thiếu baseline, liệt kê từng tài liệu; đủ baseline thì cho qua", async () => {
    const { taskId, itemId } = await seedGated({ approved: ["spec"] });
    const r = await gateOf(taskId);
    expect(r).toMatchObject({ block: true, code: SDLC_GATE_BLOCKED, itemId });
    expect(r.block && r.missing.map((m) => m.kind === "artifact" && m.name)).toEqual([
      "plan.md (Plan)",
      "tasks.md (Tasks)",
    ]);
    expect(r.block && r.message).toContain("plan.md (Plan) chưa duyệt");

    const ready = await seedGated({ approved: allDocs });
    expect(await gateOf(ready.taskId)).toEqual({ block: false, itemId: ready.itemId });
  });

  it("approval = revoked coi như chưa có baseline", async () => {
    const { taskId, artifacts } = await seedGated({ approved: allDocs });
    await admin.query("update hive.sdlc_artifacts set approval = 'revoked' where id = $1", [artifacts.plan]);
    const r = await gateOf(taskId);
    expect(r.block && r.missing).toMatchObject([{ kind: "artifact", name: "plan.md (Plan)", reason: "revoked" }]);
    await admin.query("update hive.sdlc_artifacts set approval = 'reaffirmed' where id = $1", [artifacts.plan]);
    expect((await gateOf(taskId)).block).toBe(false);
  });

  it("giai đoạn skipped không chặn", async () => {
    const { taskId, itemId } = await seedGated({ approved: ["spec", "tasks"] });
    expect((await gateOf(taskId)).block).toBe(true);
    await admin.query("update hive.sdlc_item_phases set status = 'skipped' where item_id = $1 and phase_id = 'plan'", [
      itemId,
    ]);
    expect((await gateOf(taskId)).block).toBe(false);
  });

  describe("mức chặn", () => {
    it("soft cho chạy kèm cảnh báo; none không kiểm", async () => {
      const soft = await seedGated({ blocking: "soft" });
      const r = await gateOf(soft.taskId);
      expect(r).toMatchObject({ block: false });
      expect(!r.block && r.warn).toContain("spec.md (Specify) chưa duyệt");
      const none = await seedGated({ blocking: "none" });
      expect(await gateOf(none.taskId)).toEqual({ block: false, itemId: none.itemId });
    });

    it("lấy mức chặt nhất của chế độ, bản chụp cài đặt dự án và cài đặt hiện tại", async () => {
      const { taskId, itemId } = await seedGated({ blocking: "soft" });
      expect((await gateOf(taskId)).block).toBe(false);
      await admin.query("update hive.sdlc_item_projects set settings = $2 where item_id = $1", [
        itemId,
        JSON.stringify(sdlcOn({ blocking: "hard" })),
      ]);
      expect((await gateOf(taskId)).block).toBe(true);

      const live = await seedGated({ blocking: "soft" });
      await admin.query("update hive.projects set settings = $2 where id = $1", [
        project.web.id,
        JSON.stringify({ ...defaultProjectSettings(), sdlc: sdlcOn({ blocking: "hard" }) }),
      ]);
      try {
        expect((await gateOf(live.taskId)).block).toBe(true);
      } finally {
        await admin.query("update hive.projects set settings = $2 where id = $1", [
          project.web.id,
          JSON.stringify({ ...defaultProjectSettings(), sdlc: sdlcOn() }),
        ]);
      }
    });
  });

  describe("phụ thuộc", () => {
    it("chặn khi phụ thuộc chưa done, cả khi tài liệu đã đủ; done thì cho qua", async () => {
      const { taskId, itemId } = await seedGated({ approved: allDocs });
      const dep = await seedTask(project.web.id, org.teamId, "running");
      await admin.query("insert into hive.task_dependencies (org_id, task_id, depends_on_id) values ($1, $2, $3)", [
        org.orgId,
        taskId,
        dep,
      ]);
      const r = await gateOf(taskId);
      expect(r).toMatchObject({ block: true, code: TASK_DEPENDENCIES_OPEN, itemId });
      expect(r.block && r.missing).toMatchObject([{ kind: "dependency", taskId: dep, status: "running" }]);
      await admin.query("update hive.tasks set status = 'done' where id = $1", [dep]);
      expect((await gateOf(taskId)).block).toBe(false);
    });

    it("phụ thuộc ở dự án khác cũng chặn, kể cả khi chế độ chặn none", async () => {
      const { taskId } = await seedGated({ blocking: "none" });
      const dep = await seedTask(project.api.id, org.otherTeamId);
      await admin.query("insert into hive.task_dependencies (org_id, task_id, depends_on_id) values ($1, $2, $3)", [
        org.orgId,
        taskId,
        dep,
      ]);
      expect(await gateOf(taskId)).toMatchObject({ block: true, code: TASK_DEPENDENCIES_OPEN });
    });
  });

  describe("dự án", () => {
    it("dự án đã bị bỏ khỏi hạng mục: chặn, ngoại lệ không mở được", async () => {
      const item = await seedGated({ approved: allDocs, participants: ["crm"] });
      const crmTask = await seedTask(project.crm.id, org.teamId);
      await linkTask(item.itemId, crmTask, project.crm.id);
      expect((await gateOf(crmTask)).block).toBe(false);
      await admin.query(
        "update hive.sdlc_item_projects set removed_at = now() where item_id = $1 and project_id = $2",
        [item.itemId, project.crm.id],
      );
      await admin.query(
        "insert into hive.sdlc_overrides (org_id, item_id, reason, decided_by) values ($1, $2, $3, 'u')",
        [org.orgId, item.itemId, "Ngoại lệ cả hạng mục"],
      );
      expect(await gateOf(crmTask)).toMatchObject({
        block: true,
        code: SDLC_GATE_BLOCKED,
        message: `Dự án ${project.crm.key} đã tắt AI SDLC.`,
      });
      expect((await gateOf(item.taskId)).block).toBe(false);
    });

    it("dự án tắt AI SDLC thì chặn", async () => {
      const { taskId } = await seedGated({ approved: allDocs });
      await admin.query("update hive.projects set settings = $2 where id = $1", [
        project.web.id,
        JSON.stringify(defaultProjectSettings()),
      ]);
      try {
        expect(await gateOf(taskId)).toMatchObject({
          block: true,
          message: `Dự án ${project.web.key} đã tắt AI SDLC.`,
        });
      } finally {
        await admin.query("update hive.projects set settings = $2 where id = $1", [
          project.web.id,
          JSON.stringify({ ...defaultProjectSettings(), sdlc: sdlcOn() }),
        ]);
      }
    });
  });

  describe("hạng mục ba dự án", () => {
    it("contract chưa duyệt chặn bên cung cấp và bên dùng, không chặn dự án khác", async () => {
      const item = await seedItem({ approved: allDocs, participants: ["api", "crm"] });
      await admin.query(
        `insert into hive.sdlc_artifacts (org_id, project_id, item_id, phase_id, artifact_id, required, scope, instance,
           consumer_project_ids, doc_key, repo_path)
         values ($1, $2, $3, 'plan', 'contract', true, 'contract', 'refund-api', $4, $5, 'specs/x/contracts/refund-api.yaml')`,
        [
          org.orgId,
          project.api.id,
          item.itemId,
          [project.web.id],
          `project/${project.web.key}/sdlc/${item.number}-hoan-tien/contracts/refund-api`,
        ],
      );
      const tasks = {
        api: await seedTask(project.api.id, org.otherTeamId),
        web: await seedTask(project.web.id, org.teamId),
        crm: await seedTask(project.crm.id, org.teamId),
      };
      await linkTask(item.itemId, tasks.api, project.api.id);
      await linkTask(item.itemId, tasks.web, project.web.id);
      await linkTask(item.itemId, tasks.crm, project.crm.id);

      for (const name of ["api", "web"] as const) {
        const r = await gateOf(tasks[name]);
        expect(r.block && r.missing).toMatchObject([{ kind: "artifact", name: "contract refund-api" }]);
      }
      expect(await gateOf(tasks.crm)).toEqual({ block: false, itemId: item.itemId });

      await admin.query(
        "update hive.sdlc_artifacts set baseline_version = 1, approval = 'human' where item_id = $1 and scope = 'contract'",
        [item.itemId],
      );
      expect((await gateOf(tasks.api)).block).toBe(false);
      expect((await gateOf(tasks.web)).block).toBe(false);
    });
  });
});

describe("ngoại lệ", () => {
  const create = (who: string, input: Parameters<typeof createOverride>[2]) =>
    as(who, (tx) => createOverride(tx, org.user(who), input));
  const revoke = (who: string, id: string) => as(who, (tx) => revokeOverride(tx, org.user(who), id));

  it("ngoại lệ task: cho run qua, có audit và thông báo; thu hồi thì chặn lại", async () => {
    const { itemId, taskId } = await seedGated();
    const other = await seedTask(project.web.id, org.teamId);
    await linkTask(itemId, other, project.web.id);
    expect((await gateOf(taskId)).block).toBe(true);

    const ov = await create("tadmin", { itemId, taskId, reason: "Hotfix khách hàng A" });
    expect(ov).toMatchObject({ taskId, projectId: null, reason: "Hotfix khách hàng A", active: true, revokedAt: null });
    expect(ov.decidedBy).toEqual({ userId: org.user("tadmin"), name: org.user("tadmin") });
    expect(await gateOf(taskId)).toEqual({ block: false, itemId, overrideId: ov.id });
    expect((await gateOf(other)).block).toBe(true);

    const audit = await admin.query(
      "select actor_user_id, data from hive.audit_log where action = 'sdlc.override.create' and data->>'overrideId' = $1",
      [ov.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_user_id: org.user("tadmin"),
      data: { itemId, taskId, scope: "task", reason: "Hotfix khách hàng A" },
    });
    // Quản trị tổ chức và chủ hạng mục nhận thông báo; thành viên thường thì không.
    const inbox = await admin.query(
      "select user_id from hive.inbox_items where org_id = $1 and event = 'sdlc.override' and event_key = $2",
      [org.orgId, `sdlc.override:create:${ov.id}`],
    );
    const who = inbox.rows.map((r) => r.user_id as string);
    expect(who).toEqual(expect.arrayContaining([org.user("owner"), org.user("admin"), org.user("tmember")]));
    expect(who).not.toContain(org.user("tviewer"));

    const revoked = await revoke("tadmin", ov.id);
    expect(revoked).toMatchObject({ active: false, revokedBy: { userId: org.user("tadmin") } });
    expect((await gateOf(taskId)).block).toBe(true);
    expect(
      (
        await admin.query(
          "select 1 from hive.audit_log where action = 'sdlc.override.revoke' and data->>'overrideId' = $1",
          [ov.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(await as("admin", (tx) => listOverrides(tx, itemId))).toMatchObject([{ id: ov.id, active: false }]);
  });

  it("ngoại lệ phạm vi dự án chỉ phủ task của dự án đó trong hạng mục", async () => {
    const item = await seedItem({ approved: ["spec"], participants: ["api"] });
    const webTask = await seedTask(project.web.id, org.teamId);
    const apiTask = await seedTask(project.api.id, org.otherTeamId);
    await linkTask(item.itemId, webTask, project.web.id);
    await linkTask(item.itemId, apiTask, project.api.id);

    const ov = await create("oadmin", { itemId: item.itemId, projectId: project.api.id, reason: "Mở cho đội API" });
    expect(await gateOf(apiTask)).toMatchObject({ block: false, overrideId: ov.id });
    expect((await gateOf(webTask)).block).toBe(true);
  });

  it("ngoại lệ cả hạng mục cần quyền ở đội của mọi dự án tham gia", async () => {
    const item = await seedItem({ participants: ["api"] });
    const web = await seedTask(project.web.id, org.teamId);
    const api = await seedTask(project.api.id, org.otherTeamId);
    await linkTask(item.itemId, web, project.web.id);
    await linkTask(item.itemId, api, project.api.id);
    const input = { itemId: item.itemId, reason: "Cả hạng mục chạy gấp" };

    expect(await errorCode(() => create("tadmin", input))).toBe("SDLC_OVERRIDE_FORBIDDEN");
    expect(await errorCode(() => create("oadmin", input))).toBe("SDLC_OVERRIDE_FORBIDDEN");
    // Quản trị tổ chức có quyền ở mọi đội.
    const ov = await create("admin", input);
    expect(ov).toMatchObject({ taskId: null, projectId: null });
    expect(await gateOf(web)).toMatchObject({ block: false, overrideId: ov.id });
    expect(await gateOf(api)).toMatchObject({ block: false, overrideId: ov.id });

    // Một đội có quyền là đủ để thu hồi vì thu hồi chỉ làm cổng chặt lại.
    await revoke("oadmin", ov.id);
    expect((await gateOf(web)).block).toBe(true);
  });

  it("từ chối người thiếu sdlc.override, lý do ngắn, hạn quá khứ, phạm vi sai", async () => {
    const { itemId, taskId } = await seedGated();
    const ok = { itemId, taskId, reason: "Lý do đủ dài" };
    expect(await errorCode(() => create("tmember", ok))).toBe("SDLC_OVERRIDE_FORBIDDEN");
    expect(await errorCode(() => create("tviewer", ok))).toBe("SDLC_OVERRIDE_FORBIDDEN");
    // Quản trị đội kia không có quyền ở đội của dự án web.
    expect(await errorCode(() => create("oadmin", ok))).toBe("SDLC_OVERRIDE_FORBIDDEN");
    expect(await errorCode(() => create("tadmin", { ...ok, reason: "ngắn quá" }))).toBe("SDLC_OVERRIDE_REASON");
    expect(await errorCode(() => create("tadmin", { ...ok, reason: "         ngắn      " }))).toBe(
      "SDLC_OVERRIDE_REASON",
    );
    expect(
      await errorCode(() => create("tadmin", { ...ok, expiresAt: new Date(Date.now() - HOUR).toISOString() })),
    ).toBe("SDLC_OVERRIDE_EXPIRY");
    expect(await errorCode(() => create("tadmin", { ...ok, projectId: project.web.id }))).toBe("SDLC_OVERRIDE_SCOPE");
    expect(await errorCode(() => create("tadmin", { ...ok, taskId: randomUUID() }))).toBe("SDLC_TASK_NOT_IN_ITEM");
    expect(await errorCode(() => create("tadmin", { itemId, projectId: project.api.id, reason: ok.reason }))).toBe(
      "SDLC_PROJECT_NOT_IN_ITEM",
    );
    expect(await errorCode(() => create("tadmin", { ...ok, itemId: randomUUID() }))).toBe("SDLC_ITEM_NOT_FOUND");
    expect((await admin.query("select 1 from hive.sdlc_overrides where item_id = $1", [itemId])).rowCount).toBe(0);
    expect((await gateOf(taskId)).block).toBe(true);
  });

  it("hạng mục đã đóng không nhận ngoại lệ mới", async () => {
    const { itemId, taskId } = await seedGated();
    await admin.query("update hive.sdlc_items set status = 'cancelled' where id = $1", [itemId]);
    expect(await errorCode(() => create("tadmin", { itemId, taskId, reason: "Lý do đủ dài" }))).toBe(
      "SDLC_ITEM_CLOSED",
    );
  });

  it("ngoại lệ hết hạn thì không còn hiệu lực; run đã tạo trước đó không bị ảnh hưởng", async () => {
    const { itemId, taskId } = await seedGated();
    const expiresAt = new Date(Date.now() + HOUR);
    const ov = await create("tadmin", { itemId, taskId, reason: "Hotfix có hạn", expiresAt: expiresAt.toISOString() });
    expect(ov).toMatchObject({ active: true, expiresAt: expiresAt.toISOString() });
    expect((await gateOf(taskId)).block).toBe(false);
    expect((await gateOf(taskId, new Date(expiresAt.getTime() + 1))).block).toBe(true);
    // Hết hạn thì không thu hồi được nữa.
    await admin.query("update hive.sdlc_overrides set expires_at = now() - interval '1 minute' where id = $1", [ov.id]);
    expect(await errorCode(() => revoke("tadmin", ov.id))).toBe("SDLC_OVERRIDE_INACTIVE");
    expect((await as("admin", (tx) => listOverrides(tx, itemId)))[0]?.active).toBe(false);
  });

  it("thu hồi: không tìm thấy, thiếu quyền, thu hồi hai lần", async () => {
    const { itemId, taskId } = await seedGated();
    const ov = await create("tadmin", { itemId, taskId, reason: "Hotfix khách hàng A" });
    expect(await errorCode(() => revoke("tadmin", randomUUID()))).toBe("SDLC_OVERRIDE_NOT_FOUND");
    expect(await errorCode(() => revoke("tmember", ov.id))).toBe("SDLC_OVERRIDE_FORBIDDEN");
    expect(await errorCode(() => revoke("oadmin", ov.id))).toBe("SDLC_OVERRIDE_FORBIDDEN");
    await revoke("tadmin", ov.id);
    expect(await errorCode(() => revoke("tadmin", ov.id))).toBe("SDLC_OVERRIDE_INACTIVE");
    expect(
      (
        await admin.query("select 1 from hive.audit_log where action = 'sdlc.override.revoke' and target_id = $1", [
          itemId,
        ])
      ).rowCount,
    ).toBe(1);
  });

  it("ngoại lệ không mở được dự án đã tắt AI SDLC nhưng mở được phụ thuộc chưa xong", async () => {
    const { itemId, taskId } = await seedGated({ approved: allDocs });
    const dep = await seedTask(project.web.id, org.teamId);
    await admin.query("insert into hive.task_dependencies (org_id, task_id, depends_on_id) values ($1, $2, $3)", [
      org.orgId,
      taskId,
      dep,
    ]);
    expect(await gateOf(taskId)).toMatchObject({ block: true, code: TASK_DEPENDENCIES_OPEN });
    const ov = await create("tadmin", { itemId, taskId, reason: "Phụ thuộc đã xong ngoài hệ thống" });
    expect(await gateOf(taskId)).toMatchObject({ block: false, overrideId: ov.id });
  });
});
