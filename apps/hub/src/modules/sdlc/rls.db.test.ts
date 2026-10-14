import { randomBytes, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  sdlcArtifactSyncs,
  sdlcArtifacts,
  sdlcAutoApprovals,
  sdlcItemPhases,
  sdlcItemProjects,
  sdlcItems,
  sdlcItemTasks,
  sdlcModes,
  sdlcOverrides,
  sdlcQuestions,
  sdlcSteps,
  sdlcTraceLinks,
} from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

const TABLES: Record<string, PgTable & { orgId: unknown }> = {
  sdlc_modes: sdlcModes,
  sdlc_items: sdlcItems,
  sdlc_item_projects: sdlcItemProjects,
  sdlc_item_phases: sdlcItemPhases,
  sdlc_artifacts: sdlcArtifacts,
  sdlc_artifact_syncs: sdlcArtifactSyncs,
  sdlc_questions: sdlcQuestions,
  sdlc_steps: sdlcSteps,
  sdlc_item_tasks: sdlcItemTasks,
  sdlc_trace_links: sdlcTraceLinks,
  sdlc_overrides: sdlcOverrides,
  sdlc_auto_approvals: sdlcAutoApprovals,
};

type Org = OrgFixture & { user: (n: string) => string };
type Seeded = { org: Org; projectId: string; taskId: string; itemId: string; artifactId: string };
const seeded: Record<"a" | "b", Seeded> = {} as never;

/** Seed mỗi bảng một dòng bằng superuser để test RLS đứng độc lập với nghiệp vụ hạng mục. */
async function seed(name: "a" | "b") {
  const org = await seedOrg(admin, `sdlc-rls-${name}-${randomUUID().slice(0, 6)}`);
  const { orgId, teamId } = org;
  const { projectId } = await seedProject(admin, app, {
    orgId,
    teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: `sdlc-rls-${name}`,
  });
  const one = async (q: string, p: unknown[]) => (await admin.query(q, p)).rows[0].id as string;
  const taskId = await one(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
     values ($1, $2, $3, 1, 'k-1', 't', 'u') returning id`,
    [orgId, teamId, projectId],
  );
  await admin.query(
    `insert into hive.sdlc_modes (org_id, slug, name, method, definition, created_by)
     values ($1, 'nhanh', 'Nhanh', 'hive', '{}', 'u')`,
    [orgId],
  );
  const itemId = await one(
    `insert into hive.sdlc_items (org_id, team_id, project_id, number, slug, title, idea, source, mode_ref, mode,
       settings, size, owner_user_id, created_by)
     values ($1, $2, $3, 1, 'dang-nhap', 'Đăng nhập', 'Ý tưởng', '{"kind":"manual"}', 'bugfix', '{}', '{}', 'S',
       'u', 'u') returning id`,
    [orgId, teamId, projectId],
  );
  await admin.query(
    `insert into hive.sdlc_item_projects (org_id, item_id, project_id, team_id, role, settings, added_by)
     values ($1, $2, $3, $4, 'home', '{}', 'u')`,
    [orgId, itemId, projectId, teamId],
  );
  await admin.query(
    `insert into hive.sdlc_item_phases (org_id, item_id, phase_index, phase_id, kind)
     values ($1, $2, 0, 'spec', 'requirements')`,
    [orgId, itemId],
  );
  const artifactId = await one(
    `insert into hive.sdlc_artifacts (org_id, project_id, item_id, phase_id, artifact_id, required, doc_key, repo_path)
     values ($1, $2, $3, 'spec', 'spec', true, $4, 'specs/001-dang-nhap/spec.md') returning id`,
    [orgId, projectId, itemId, `project/${projectId}/sdlc/001-dang-nhap/spec`],
  );
  await admin.query(
    `insert into hive.sdlc_artifact_syncs (org_id, artifact_id, project_id, kind, repo_path)
     values ($1, $2, $3, 'source', 'specs/001-dang-nhap/spec.md')`,
    [orgId, artifactId, projectId],
  );
  await admin.query(
    `insert into hive.sdlc_questions (org_id, item_id, phase_id, round, position, text)
     values ($1, $2, 'spec', 1, 0, 'Đăng nhập bằng gì?')`,
    [orgId, itemId],
  );
  await admin.query(
    `insert into hive.sdlc_steps (org_id, item_id, phase_id, step_id, action, created_by)
     values ($1, $2, 'spec', 'draft', 'draft', 'u')`,
    [orgId, itemId],
  );
  await admin.query(
    `insert into hive.sdlc_item_tasks (org_id, item_id, task_id, project_id, slice_key, wave, breakdown_version)
     values ($1, $2, $3, $4, 'T001', 1, 1)`,
    [orgId, itemId, taskId, projectId],
  );
  await admin.query(
    `insert into hive.sdlc_trace_links (org_id, item_id, requirement_id, kind, ref, task_id)
     values ($1, $2, 'FR-001', 'task', $3::text, $3::uuid)`,
    [orgId, itemId, taskId],
  );
  await admin.query(
    `insert into hive.sdlc_overrides (org_id, item_id, task_id, reason, decided_by)
     values ($1, $2, $3, 'Sửa gấp lỗi đăng nhập', 'u')`,
    [orgId, itemId, taskId],
  );
  await admin.query(
    `insert into hive.sdlc_auto_approvals (org_id, item_id, artifact_id, review_id, gate_id, score, threshold, reasons,
       revocable_until)
     values ($1, $2, $3, $4, 'ai', 9.5, 9, '{}', now() + interval '1 day')`,
    [orgId, itemId, artifactId, randomUUID()],
  );
  seeded[name] = { org, projectId, taskId, itemId, artifactId };
}

beforeAll(async () => {
  await seed("a");
  await seed("b");
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const inA = (fn: (tx: Tx) => Promise<unknown>) => pgCode(() => withTenant(app, { orgId: seeded.a.org.orgId }, fn));

/** Hạng mục tối thiểu của A, để thử ràng buộc của bảng hạng mục. */
const item = (over: Partial<typeof sdlcItems.$inferInsert> = {}): typeof sdlcItems.$inferInsert => ({
  orgId: seeded.a.org.orgId,
  teamId: seeded.a.org.teamId,
  projectId: seeded.a.projectId,
  number: 100 + Math.floor(Math.random() * 1_000_000),
  slug: "thu",
  title: "Thử",
  idea: "Ý tưởng",
  source: { kind: "manual", url: null, issueNumber: null, path: null },
  modeRef: "bugfix",
  mode: {} as never,
  settings: {} as never,
  size: "S",
  ownerUserId: "u",
  createdBy: "u",
  ...over,
});

describe("RLS bảng AI SDLC", () => {
  it("không có context thì mọi bảng trả 0 dòng", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const [name, table] of Object.entries(TABLES)) {
        expect([name, (await tx.select().from(table)).length]).toEqual([name, 0]);
      }
    });
  });

  it("context tổ chức A chỉ thấy dữ liệu của A ở mọi bảng", async () => {
    await withTenant(app, { orgId: seeded.a.org.orgId }, async (tx) => {
      for (const [name, table] of Object.entries(TABLES)) {
        const rows = (await tx.select().from(table)) as { orgId: string }[];
        expect([name, rows.length > 0]).toEqual([name, true]);
        expect([name, rows.every((r) => r.orgId === seeded.a.org.orgId)]).toEqual([name, true]);
      }
    });
  });

  it("không ghi được hạng mục cho tổ chức khác, UPDATE không chuyển được sang tổ chức khác", async () => {
    const b = seeded.b;
    expect(
      await inA((tx) =>
        tx.insert(sdlcItems).values(item({ orgId: b.org.orgId, teamId: b.org.teamId, projectId: b.projectId })),
      ),
    ).toBe("42501");
    expect(
      await inA((tx) => tx.update(sdlcItems).set({ orgId: b.org.orgId }).where(eq(sdlcItems.id, seeded.a.itemId))),
    ).toBe("42501");
    expect(
      await inA((tx) =>
        tx.insert(sdlcQuestions).values({
          orgId: b.org.orgId,
          itemId: b.itemId,
          phaseId: "spec",
          round: 1,
          position: 1,
          text: "?",
        }),
      ),
    ).toBe("42501");
  });

  it("A không sửa hay xoá được dòng của B", async () => {
    const b = seeded.b;
    await withTenant(app, { orgId: seeded.a.org.orgId }, async (tx) => {
      expect(
        await tx.update(sdlcItems).set({ status: "cancelled" }).where(eq(sdlcItems.id, b.itemId)).returning(),
      ).toHaveLength(0);
      expect(await tx.delete(sdlcArtifacts).where(eq(sdlcArtifacts.id, b.artifactId)).returning()).toHaveLength(0);
      expect(await tx.delete(sdlcItemTasks).where(eq(sdlcItemTasks.taskId, b.taskId)).returning()).toHaveLength(0);
    });
  });

  it("dòng con không trỏ được tới hạng mục, tài liệu hay task của tổ chức khác (khoá kép)", async () => {
    const a = seeded.a;
    const b = seeded.b;
    const orgId = a.org.orgId;
    // Task của B chưa thuộc hạng mục nào, để chỉ khoá ngoại chặn (chỉ mục duy nhất theo task kiểm trước khoá ngoại).
    const { rows } = await admin.query(
      `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
       values ($1, $2, $3, 60, 'k-60', 't', 'u') returning id`,
      [b.org.orgId, b.org.teamId, b.projectId],
    );
    const freeTaskOfB = rows[0].id as string;
    expect(
      await inA((tx) =>
        tx.insert(sdlcItemPhases).values({ orgId, itemId: b.itemId, phaseIndex: 9, phaseId: "x", kind: "x" }),
      ),
    ).toBe("23503");
    expect(
      await inA((tx) =>
        tx
          .insert(sdlcArtifactSyncs)
          .values({ orgId, artifactId: b.artifactId, projectId: a.projectId, kind: "copy", repoPath: "x" }),
      ),
    ).toBe("23503");
    expect(
      await inA((tx) =>
        tx.insert(sdlcItemTasks).values({
          orgId,
          itemId: a.itemId,
          taskId: freeTaskOfB,
          projectId: a.projectId,
          sliceKey: "T099",
          wave: 1,
          breakdownVersion: 1,
        }),
      ),
    ).toBe("23503");
    expect(
      await inA((tx) =>
        tx
          .insert(sdlcOverrides)
          .values({ orgId, itemId: a.itemId, taskId: b.taskId, reason: "Lý do đủ dài", decidedBy: "u" }),
      ),
    ).toBe("23503");
    expect(
      await inA((tx) =>
        tx.insert(sdlcAutoApprovals).values({
          orgId,
          itemId: a.itemId,
          artifactId: b.artifactId,
          reviewId: randomUUID(),
          gateId: "ai",
          score: 9,
          threshold: 9,
          reasons: {},
          revocableUntil: new Date(),
        }),
      ),
    ).toBe("23503");
  });

  it("ràng buộc CHECK chặn trạng thái, cỡ, vai trò sai và lý do quá ngắn", async () => {
    const a = seeded.a;
    const orgId = a.org.orgId;
    // biome-ignore lint/suspicious/noExplicitAny: cố ý ghi giá trị sai kiểu để thử ràng buộc
    const bogus = "bogus" as any;
    expect(await inA((tx) => tx.insert(sdlcItems).values(item({ status: bogus })))).toBe("23514");
    expect(await inA((tx) => tx.insert(sdlcItems).values(item({ size: bogus })))).toBe("23514");
    expect(
      await inA((tx) => tx.insert(sdlcOverrides).values({ orgId, itemId: a.itemId, reason: "gấp", decidedBy: "u" })),
    ).toBe("23514");
    const approval = {
      orgId,
      itemId: a.itemId,
      artifactId: a.artifactId,
      reviewId: randomUUID(),
      gateId: "ai",
      score: 9,
      threshold: 9,
      reasons: {},
      revocableUntil: new Date(),
      revokedAt: new Date(),
    };
    expect(await inA((tx) => tx.insert(sdlcAutoApprovals).values({ ...approval, revokeReason: "sai" }))).toBe("23514");
    expect(
      await inA((tx) => tx.insert(sdlcAutoApprovals).values({ ...approval, revokeReason: "Điểm chấm chưa đúng" })),
    ).toBeUndefined();
    expect(
      await inA((tx) =>
        tx.insert(sdlcArtifacts).values({
          orgId,
          projectId: a.projectId,
          itemId: a.itemId,
          phaseId: "x",
          artifactId: "x",
          required: false,
          docKey: `k-${randomUUID()}`,
          repoPath: "x",
          approval: bogus,
        }),
      ),
    ).toBe("23514");
  });

  it("mỗi hạng mục một dự án chính; một issue chỉ thành một hạng mục", async () => {
    const a = seeded.a;
    const orgId = a.org.orgId;
    expect(
      await inA((tx) =>
        tx.insert(sdlcItemProjects).values({
          orgId,
          itemId: a.itemId,
          projectId: randomUUID(),
          teamId: a.org.teamId,
          role: "home",
          settings: {} as never,
          addedBy: "u",
        }),
      ),
    ).toBe("23505");
    const fromIssue = () =>
      inA((tx) =>
        tx
          .insert(sdlcItems)
          .values(item({ source: { kind: "issue", url: "https://git.test/i/7", issueNumber: 7, path: null } })),
      );
    expect(await fromIssue()).toBeUndefined();
    expect(await fromIssue()).toBe("23505");
    // Hạng mục tạo tay không bị chỉ mục issue chặn.
    expect(await inA((tx) => tx.insert(sdlcItems).values(item()))).toBeUndefined();
    expect(await inA((tx) => tx.insert(sdlcItems).values(item()))).toBeUndefined();
  });

  it("xoá hạng mục thì xoá dòng con; xoá task thì xoá liên kết task của hạng mục", async () => {
    const a = seeded.a;
    const { rows } = await admin.query(
      `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
       values ($1, $2, $3, 50, 'k-50', 't', 'u') returning id`,
      [a.org.orgId, a.org.teamId, a.projectId],
    );
    const taskId = rows[0].id as string;
    const [created] = await withTenant(app, { orgId: a.org.orgId }, async (tx) => {
      const out = await tx.insert(sdlcItems).values(item()).returning();
      const itemId = (out[0] as { id: string }).id;
      await tx.insert(sdlcItemTasks).values({
        orgId: a.org.orgId,
        itemId,
        taskId,
        projectId: a.projectId,
        sliceKey: "T001",
        wave: 1,
        breakdownVersion: 1,
      });
      await tx
        .insert(sdlcQuestions)
        .values({ orgId: a.org.orgId, itemId, phaseId: "spec", round: 1, position: 0, text: "?" });
      return out;
    });
    const itemId = (created as { id: string }).id;
    await admin.query("delete from hive.tasks where id = $1", [taskId]);
    expect((await admin.query("select 1 from hive.sdlc_item_tasks where task_id = $1", [taskId])).rowCount).toBe(0);
    await admin.query("delete from hive.sdlc_items where id = $1", [itemId]);
    expect((await admin.query("select 1 from hive.sdlc_questions where item_id = $1", [itemId])).rowCount).toBe(0);
  });

  it("mọi bảng bật và ép RLS", async () => {
    const names = Object.keys(TABLES);
    const { rows } = await admin.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'hive' and c.relname = any($1)`,
      [names],
    );
    expect(rows).toHaveLength(names.length);
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it("hive_app không TRUNCATE được", async () => {
    expect(await inA((tx) => tx.execute(sql`truncate hive.sdlc_items cascade`))).toBe("42501");
  });

  it("hive.sdlc_active_orgs chỉ trả tổ chức có hạng mục đang chạy", async () => {
    const active = async () =>
      withTenant(app, {}, async (tx) => {
        const res = await tx.execute<{ org_id: string }>(sql`select org_id from hive.sdlc_active_orgs()`);
        return res.rows.map((r) => r.org_id);
      });
    const before = await active();
    expect(before).toContain(seeded.b.org.orgId);
    await admin.query("update hive.sdlc_items set status = 'paused' where org_id = $1", [seeded.b.org.orgId]);
    const after = await active();
    expect(after).not.toContain(seeded.b.org.orgId);
    expect(after).toContain(seeded.a.org.orgId);
  });
});
