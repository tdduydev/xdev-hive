import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings, SDLC_PRESETS, type SdlcMode } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { readerFor } from "../knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import {
  docAccessFor,
  itemForUser,
  itemViewers,
  projectItemsWhere,
  requireProjectWrite,
  sdlcReaderFor,
  visibleItemsWhere,
} from "./access.ts";
import { insertItemProjects, resolveItemProjects } from "./participants.ts";
import { sdlcItems } from "./schema.ts";

/*
 * SC-013 phần của bộ lọc quyền (D22): ba đội Backend (A), Web (B), Mobile (C). Hạng mục ở dự án A, dự án B tham gia; đội C
 * không tham gia. Route list/get/board/questions/trace của T012/T031 dùng đúng các hàm này nên ca của route nằm ở test
 * của task đó.
 */

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let teamC = "";
const project: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
const key = (p: string) => `${p}${tag}`;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

const enabled = () => ({ ...defaultProjectSettings(), sdlc: projectSdlcSettings.parse({ enabled: true }) });

async function addUser(name: string, memberships: [team: string, role: string][]) {
  const id = org.user(name);
  await admin.query(
    `insert into auth."user" (id, name, email) values ($1, $1, $1 || '@seed.test') on conflict do nothing`,
    [id],
  );
  await admin.query("insert into hive.org_members (org_id, user_id, role) values ($1, $2, 'member')", [org.orgId, id]);
  for (const [team, role] of memberships)
    await admin.query("insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, $4)", [
      team,
      org.orgId,
      id,
      role,
    ]);
}

async function seedSdlcProject(k: string, teamId: string, systemId: string) {
  return (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId,
      systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: key(k),
      settings: enabled(),
    })
  ).projectId;
}

let n = 0;
/** Dòng hạng mục chèn bằng superuser (tạo hạng mục là việc của items.ts, T012); dòng dự án ghi bằng hàm thật. */
async function seedItem(creator: string, home: string, participants: string[]): Promise<string> {
  const { rows } = await admin.query(
    `insert into hive.sdlc_items (org_id, team_id, project_id, number, slug, title, idea, source, mode_ref, mode,
       settings, size, owner_user_id, created_by)
     select $1, p.team_id, p.id, $3, 'hoan-tien', 'Hoàn tiền một phần', 'Ý tưởng đủ dài để qua kiểm tra',
       '{"kind":"manual"}', 'speckit', $4, '{}', 'M', $5, $5
     from hive.projects p where p.id = $2 returning id`,
    [org.orgId, home, ++n, JSON.stringify(SDLC_PRESETS.speckit as SdlcMode), org.user(creator)],
  );
  const itemId = rows[0].id as string;
  await as(creator, async (tx) =>
    insertItemProjects(
      tx,
      itemId,
      await resolveItemProjects(tx, org.user(creator), { projectId: home, participants }),
      org.user(creator),
    ),
  );
  return itemId;
}

const visibleIds = (who: string) =>
  as(who, async (tx) => {
    const reader = await sdlcReaderFor(tx, org.user(who));
    const rows = await tx.select({ id: sdlcItems.id }).from(sdlcItems).where(visibleItemsWhere(reader));
    return rows.map((r) => r.id).sort();
  });

beforeAll(async () => {
  org = await seedOrg(admin, `sda-${tag}`);
  teamC = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'mobile', 'Mobile') returning id", [
      org.orgId,
    ])
  ).rows[0].id;
  const systemC = (
    await admin.query(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 'app', 'App') returning id",
      [org.orgId, teamC],
    )
  ).rows[0].id as string;
  // seedOrg: tadmin/tmember/tviewer ở đội A, oadmin quản trị đội B, loner không ở đội nào.
  await addUser("bmember", [[org.otherTeamId, "member"]]);
  await addUser("bviewer", [[org.otherTeamId, "viewer"]]);
  await addUser("cmember", [[teamC, "member"]]);
  await addUser("both", [
    [org.teamId, "member"],
    [org.otherTeamId, "member"],
  ]);
  await addUser("aba", [[org.teamId, "ba"]]);
  project.a = await seedSdlcProject("a", org.teamId, org.systemId);
  project.b = await seedSdlcProject("b", org.otherTeamId, org.otherSystemId);
  project.c = await seedSdlcProject("c", teamC, systemC);
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("visibleItemsWhere", () => {
  it("thành viên đội của bất kỳ dự án tham gia nào thấy hạng mục, đội không tham gia thì không", async () => {
    const item = await seedItem("both", project.a, [project.b]);
    const other = await seedItem("cmember", project.c, []);
    expect(await visibleIds("tmember")).toEqual([item]);
    expect(await visibleIds("tviewer")).toEqual([item]);
    expect(await visibleIds("aba")).toEqual([item]);
    expect(await visibleIds("bmember")).toEqual([item]);
    expect(await visibleIds("bviewer")).toEqual([item]);
    expect(await visibleIds("cmember")).toEqual([other]);
    expect(await visibleIds("loner")).toEqual([]);
    // Quản trị tổ chức là quản trị mọi đội (teamRolesOf) nên thấy cả hai.
    expect(await visibleIds("admin")).toEqual([item, other].sort());
  });

  it("dự án bị bỏ khỏi hạng mục không còn mở quyền xem cho đội của nó", async () => {
    const item = await seedItem("both", project.a, [project.b]);
    await admin.query("update hive.sdlc_item_projects set removed_at = now() where item_id = $1 and project_id = $2", [
      item,
      project.b,
    ]);
    expect(await visibleIds("bmember")).toEqual([]);
    expect(await visibleIds("tmember")).toEqual([item]);
  });

  it("itemForUser báo không tìm thấy cho người ngoài, không lộ tiêu đề", async () => {
    const item = await seedItem("both", project.a, [project.b]);
    expect((await as("bmember", (tx) => itemForUser(tx, org.user("bmember"), item))).title).toBe("Hoàn tiền một phần");
    expect(await errorCode(() => as("cmember", (tx) => itemForUser(tx, org.user("cmember"), item)))).toBe(
      "SDLC_ITEM_NOT_FOUND",
    );
    expect(await errorCode(() => as("loner", (tx) => itemForUser(tx, org.user("loner"), item)))).toBe(
      "SDLC_ITEM_NOT_FOUND",
    );
  });

  it("run chỉ thấy hạng mục có dự án của run", async () => {
    const item = await seedItem("both", project.a, [project.b]);
    const runSees = (p: string) =>
      as("admin", async (tx) =>
        (await tx.select({ id: sdlcItems.id }).from(sdlcItems).where(projectItemsWhere(p))).map((r) => r.id),
      );
    expect(await runSees(project.b)).toEqual([item]);
    expect(await runSees(project.c)).toEqual([]);
  });
});

describe("requireProjectWrite", () => {
  const write = (who: string, ids: string[], perm: "sdlc.read" | "sdlc.write" | "sdlc.override" = "sdlc.write") =>
    as(who, (tx) => requireProjectWrite(tx, org.user(who), ids, perm));

  it("cho qua khi có quyền ở đội của mọi dự án", async () => {
    const rows = await write("both", [project.a, project.b]);
    expect(rows.map((p) => p.id)).toEqual([project.a, project.b]);
  });

  it("thiếu quyền ở một dự án thì từ chối cả thao tác, báo đúng dự án", async () => {
    const error = await as("tmember", (tx) =>
      requireProjectWrite(tx, org.user("tmember"), [project.a, project.b], "sdlc.write"),
    ).catch((e: unknown) => e as { code: string; message: string });
    expect(error).toMatchObject({
      code: "SDLC_PROJECT_FORBIDDEN",
      message: `Bạn không có quyền AI SDLC trên dự án ${key("b")}.`,
    });
  });

  it("theo vai trò đội: viewer chỉ đọc, BA/PO ghi nhưng không có sdlc.override, quản trị đội có", async () => {
    expect(await errorCode(() => write("tviewer", [project.a]))).toBe("SDLC_PROJECT_FORBIDDEN");
    expect(await write("tviewer", [project.a], "sdlc.read")).toHaveLength(1);
    expect(await write("aba", [project.a])).toHaveLength(1);
    expect(await errorCode(() => write("aba", [project.a], "sdlc.override"))).toBe("SDLC_PROJECT_FORBIDDEN");
    expect(await errorCode(() => write("tmember", [project.a], "sdlc.override"))).toBe("SDLC_PROJECT_FORBIDDEN");
    expect(await write("tadmin", [project.a], "sdlc.override")).toHaveLength(1);
  });

  it("vai trò tổ chức member không thay được vai trò ở đội", async () => {
    // Vai trò tổ chức `member` có sdlc.write để menu hiện; quyền thật phải ở đội của dự án.
    expect(await errorCode(() => write("loner", [project.a]))).toBe("SDLC_PROJECT_FORBIDDEN");
  });

  it("vai trò tự tạo gắn cho đội cộng thêm quyền ở đội đó", async () => {
    const role = (
      await admin.query(
        "insert into hive.custom_roles (org_id, name, scope, permissions, created_by) values ($1, $2, 'team', $3, 'seed') returning id",
        [org.orgId, `sdlc-${tag}`, ["sdlc.override"]],
      )
    ).rows[0].id as string;
    await admin.query("insert into hive.team_custom_roles (org_id, team_id, role_id) values ($1, $2, $3)", [
      org.orgId,
      org.teamId,
      role,
    ]);
    try {
      expect(await write("tmember", [project.a], "sdlc.override")).toHaveLength(1);
      expect(await errorCode(() => write("tmember", [project.b], "sdlc.override"))).toBe("SDLC_PROJECT_FORBIDDEN");
    } finally {
      await admin.query("delete from hive.team_custom_roles where role_id = $1", [role]);
      await admin.query("delete from hive.custom_roles where id = $1", [role]);
    }
  });

  it("dự án không có trong tổ chức báo không tìm thấy", async () => {
    expect(await errorCode(() => write("both", [project.a, randomUUID()]))).toBe("PROJECT_NOT_FOUND");
  });
});

describe("itemViewers", () => {
  it("lọc người nhận thông báo về người thấy hạng mục", async () => {
    const item = await seedItem("both", project.a, [project.b]);
    const viewers = await as("admin", (tx) =>
      itemViewers(
        tx,
        item,
        ["tmember", "bviewer", "cmember", "loner", "admin"].map((u) => org.user(u)),
      ),
    );
    expect(viewers.sort()).toEqual(["tmember", "bviewer", "admin"].map((u) => org.user(u)).sort());
  });
});

describe("docAccessFor", () => {
  async function seedArtifact(itemId: string, docKey: string) {
    await admin.query(
      `insert into hive.sdlc_artifacts (org_id, project_id, item_id, phase_id, artifact_id, required, doc_key, repo_path)
       values ($1, $2, $3, 'specify', 'spec', true, $4, 'specs/001-hoan-tien/spec.md')`,
      [org.orgId, project.a, itemId, docKey],
    );
  }

  const grant = (who: string, docKey: string) =>
    as(who, async (tx) => docAccessFor(tx, await readerFor(tx, { kind: "user", userId: org.user(who) }), docKey));
  const runGrant = (projectId: string, docKey: string) =>
    as("admin", async (tx) =>
      docAccessFor(tx, await readerFor(tx, { kind: "run", runId: randomUUID(), projectId }), docKey),
    );

  it("đội tham gia đọc và đề xuất tài liệu chung; viewer chỉ đọc; đội ngoài không có gì", async () => {
    const item = await seedItem("both", project.a, [project.b]);
    const docKey = `project/${key("a")}/sdlc/001-hoan-tien/spec`;
    await seedArtifact(item, docKey);
    expect(await grant("bmember", docKey)).toEqual({ read: true, propose: true });
    expect(await grant("bviewer", docKey)).toEqual({ read: true, propose: false });
    expect(await grant("aba", docKey)).toEqual({ read: true, propose: true });
    expect(await grant("cmember", docKey)).toBeNull();
    expect(await grant("loner", docKey)).toBeNull();
  });

  it("run của dự án tham gia chỉ đọc; run của dự án ngoài không có gì", async () => {
    const item = await seedItem("both", project.a, [project.b]);
    const docKey = `project/${key("a")}/sdlc/001-hoan-tien/plan`;
    await seedArtifact(item, docKey);
    expect(await runGrant(project.b, docKey)).toEqual({ read: true, propose: false });
    expect(await runGrant(project.c, docKey)).toBeNull();
  });

  it("key không thuộc hạng mục nào thì không mở gì (giữ luật cũ của knowledge)", async () => {
    expect(await grant("bmember", `project/${key("a")}/docs/khac`)).toBeNull();
  });

  it("dự án bị bỏ thì đội của nó mất quyền đọc tài liệu chung", async () => {
    const item = await seedItem("both", project.a, [project.b]);
    const docKey = `project/${key("a")}/sdlc/001-hoan-tien/tasks`;
    await seedArtifact(item, docKey);
    await admin.query("update hive.sdlc_item_projects set removed_at = now() where item_id = $1 and project_id = $2", [
      item,
      project.b,
    ]);
    expect(await grant("bmember", docKey)).toBeNull();
    expect(
      await as("admin", (tx) => tx.select({ id: sdlcItems.id }).from(sdlcItems).where(eq(sdlcItems.id, item))),
    ).toHaveLength(1);
  });
});
