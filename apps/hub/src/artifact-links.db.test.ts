import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../test/org-fixture.ts";
import { seedProject } from "../test/project-fixture.ts";
import { type LinkTarget, provideLinkTarget, type Reader, readerFor } from "./modules/artifacts/index.ts";
import { purgeArtifacts } from "./modules/artifacts/purge.ts";
import { addLink, createArtifact, listArtifacts, listLinks } from "./modules/artifacts/service.ts";
import { createDocLinkTarget } from "./modules/knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "./modules/platform/index.ts";
import { createRunLinkTarget } from "./modules/runs/index.ts";
import { createSdlcItemLinkTarget } from "./modules/sdlc/index.ts";
import { createItem } from "./modules/sdlc/items.ts";
import { createTaskLinkTarget } from "./modules/tasks/index.ts";

/*
 * Đích gắn artifact của task, run, hạng mục AI SDLC và tài liệu (specs/012 T065): quyền gắn theo quyền sửa của module sở
 * hữu đích, tên chỉ hiện cho người xem được đích, và job dọn xoá liên kết tới đích đã mất. Mỗi module có kiểm quyền riêng
 * nên test dùng người dùng thật của seedOrg: tmember (đội A), tviewer (xem đội A), oadmin (quản trị đội B), loner.
 */
const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let projectKey = "";
let projectId = "";
let otherProjectId = "";
let taskId = "";
let runId = "";
let itemId = "";
let teamDocId = "";
let orgDocId = "";

const targets: Record<"task" | "run" | "sdlc_item" | "doc", LinkTarget> = {
  task: createTaskLinkTarget(),
  run: createRunLinkTarget(),
  sdlc_item: createSdlcItemLinkTarget(),
  doc: createDocLinkTarget(),
};
const kinds = Object.keys(targets) as (keyof typeof targets)[];

const as = <T>(who: string, fn: (tx: Tx, reader: Reader) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, async (tx) =>
    fn(tx, await readerFor(tx, { kind: "user", userId: org.user(who) })),
  );

const targetIds = () => ({ task: taskId, run: runId, sdlc_item: itemId, doc: teamDocId });

async function seedTask(title: string): Promise<string> {
  const n = Math.floor(Math.random() * 1e9);
  const { rows } = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, body, status, created_by)
     values ($1, $2, $3, $4, $5, $6, 'Mô tả', 'running', $7) returning id`,
    [org.orgId, org.teamId, projectId, n, `AL${tag}-${n}`, title, org.user("tmember")],
  );
  return rows[0].id as string;
}

async function seedDoc(key: string, title: string, scope: { teamId: string | null; projectId: string | null }) {
  const { rows } = await admin.query(
    `insert into hive.docs (org_id, team_id, project_id, key, title, current_version, updated_by_user_id)
     values ($1, $2, $3, $4, $5, 1, $6) returning id`,
    [org.orgId, scope.teamId, scope.projectId, key, title, org.user("tmember")],
  );
  return rows[0].id as string;
}

const projectArtifact = (title: string) =>
  as("tmember", (tx, r) =>
    createArtifact(tx, r, { type: "markdown", title, content: "# Nội dung", scope: "project", projectKey }),
  ).then((created) => created.artifact.id);

beforeAll(async () => {
  org = await seedOrg(admin, `al-${tag}`);
  projectKey = `al${tag}`;
  const sdlcOn = {
    ...defaultProjectSettings(),
    sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit" }),
  };
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: projectKey,
      settings: sdlcOn,
    })
  ).projectId;
  otherProjectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.otherTeamId,
      systemId: org.otherSystemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `ao${tag}`,
    })
  ).projectId;
  taskId = await seedTask("Hoàn tiền một phần");
  runId = (
    await admin.query(
      `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by)
       values ($1, $2, $3, $4, 'code', 'running', $5, '[]'::jsonb, $6) returning id`,
      [org.orgId, org.teamId, taskId, projectId, `ai/${randomUUID().slice(0, 8)}`, org.user("tmember")],
    )
  ).rows[0].id as string;
  itemId = (
    await withTenant(app, { userId: org.user("tmember"), orgId: org.orgId }, (tx) =>
      createItem(tx, org.user("tmember"), {
        projectId,
        participants: [],
        title: "Luồng hoàn tiền",
        idea: "Khách hàng được hoàn một phần tiền đơn hàng.",
        modeRef: "speckit",
        size: "M",
      }),
    )
  ).id;
  teamDocId = await seedDoc(`project/${projectKey}/hoan-tien`, "Quy trình hoàn tiền", {
    teamId: org.teamId,
    projectId,
  });
  orgDocId = await seedDoc(`org/al-${tag}`, "Quy ước chung", { teamId: null, projectId: null });
  for (const kind of kinds) provideLinkTarget(kind, targets[kind]);
});

afterAll(async () => {
  for (const kind of kinds) provideLinkTarget(kind, undefined);
  await Promise.all([admin.end(), app.end()]);
});

describe("gắn artifact vào task, run, hạng mục, tài liệu", () => {
  it("thành viên đội gắn được cả bốn loại; danh sách liên kết có tên, bỏ gắn được", async () => {
    const id = await projectArtifact("Sơ đồ hoàn tiền");
    for (const kind of kinds)
      await as("tmember", (tx, r) => addLink(tx, r, { id, targetKind: kind, targetId: targetIds()[kind] }));

    const links = await as("tmember", (tx, r) => listLinks(tx, r, { id }));
    const titleOf = (kind: string) => links.find((l) => l.targetKind === kind)?.title;
    expect(titleOf("task")).toMatch(/^AL.+ · Hoàn tiền một phần$/);
    expect(titleOf("run")).toMatch(/^Run code · AL/);
    expect(titleOf("sdlc_item")).toBe("Luồng hoàn tiền");
    expect(titleOf("doc")).toBe("Quy trình hoàn tiền");
    // Người xem đội đọc được artifact và các đích nên cũng thấy tên.
    const asViewer = await as("tviewer", (tx, r) => listLinks(tx, r, { id }));
    expect(asViewer.map((l) => l.title)).not.toContain(null);
  });

  it("người chỉ xem đội không gắn được vào đích nào, kể cả khi đọc được artifact", async () => {
    const id = await projectArtifact("Chỉ xem");
    for (const kind of kinds)
      expect(
        await errorCode(() =>
          as("tviewer", (tx, r) => addLink(tx, r, { id, targetKind: kind, targetId: targetIds()[kind] })),
        ),
      ).toBe("ARTIFACT_LINK_FORBIDDEN");
    expect(await as("tmember", (tx, r) => listLinks(tx, r, { id }))).toEqual([]);
  });

  it("người ngoài đội và người không thuộc đội nào bị từ chối như đích không tồn tại", async () => {
    for (const who of ["oadmin", "loner"])
      for (const kind of kinds) {
        expect(await errorCode(() => as(who, (tx, r) => targets[kind].assertWritable(tx, r, targetIds()[kind])))).toBe(
          "ARTIFACT_LINK_FORBIDDEN",
        );
        // Id không có thật cũng cùng mã lỗi, nên không dò được id nào tồn tại.
        expect(await errorCode(() => as(who, (tx, r) => targets[kind].assertWritable(tx, r, randomUUID())))).toBe(
          "ARTIFACT_LINK_FORBIDDEN",
        );
      }
  });

  it("run của agent không có người đứng sau thì không gắn được", async () => {
    const reader = await withTenant(app, { orgId: org.orgId }, (tx) =>
      readerFor(tx, {
        kind: "run",
        runId,
        runKind: "code",
        projectId,
        userId: null,
        taskId,
        threadId: null,
      }),
    );
    for (const kind of kinds)
      expect(
        await errorCode(() =>
          withTenant(app, { orgId: org.orgId }, (tx) => targets[kind].assertWritable(tx, reader, targetIds()[kind])),
        ),
      ).toBe("ARTIFACT_LINK_FORBIDDEN");
  });

  it("tài liệu cấp tổ chức: chỉ quản trị tổ chức gắn được, như quyền lưu tài liệu", async () => {
    expect(await errorCode(() => as("tmember", (tx, r) => targets.doc.assertWritable(tx, r, orgDocId)))).toBe(
      "ARTIFACT_LINK_FORBIDDEN",
    );
    await as("admin", (tx, r) => targets.doc.assertWritable(tx, r, orgDocId));
  });

  it("artifact riêng không gắn vào đích của dự án: đòi phạm vi đủ rộng", async () => {
    const priv = await as("tmember", (tx, r) =>
      createArtifact(tx, r, { type: "markdown", title: "Riêng", content: "x" }),
    ).then((created) => created.artifact.id);
    for (const kind of kinds)
      expect(
        await errorCode(() =>
          as("tmember", (tx, r) => addLink(tx, r, { id: priv, targetKind: kind, targetId: targetIds()[kind] })),
        ),
      ).toBe("ARTIFACT_SCOPE_TOO_NARROW");
  });
});

describe("tên và dự án của đích", () => {
  const titlesOf = async (kind: (typeof kinds)[number], tx: Tx, r: Reader) =>
    (await targets[kind].titles?.(tx, r, [targetIds()[kind]])) ?? new Map<string, string>();

  it("tên chỉ hiện cho người xem được đích", async () => {
    for (const who of ["oadmin", "loner"])
      for (const kind of kinds) expect(await as(who, (tx, r) => titlesOf(kind, tx, r))).toEqual(new Map());
    for (const kind of kinds) {
      const shown = await as("tviewer", (tx, r) => titlesOf(kind, tx, r));
      expect(shown?.get(targetIds()[kind])).toBeTruthy();
    }
  });

  it("projectOf trả dự án của đích; tài liệu cấp tổ chức không thuộc dự án nào", async () => {
    for (const kind of kinds)
      expect(await as("tmember", (tx) => targets[kind].projectOf(tx, targetIds()[kind]))).toBe(projectId);
    expect(await as("tmember", (tx) => targets.doc.projectOf(tx, orgDocId))).toBeNull();
    expect(await as("tmember", (tx) => targets.task.projectOf(tx, randomUUID()))).toBeNull();
    expect(otherProjectId).not.toBe(projectId);
  });
});

describe("danh sách theo đích", () => {
  it("lọc theo task, run, hạng mục và tài liệu chỉ ra artifact đã gắn, và theo quyền đọc của người xem", async () => {
    const id = await projectArtifact("Gắn khắp nơi");
    const other = await projectArtifact("Không gắn");
    for (const kind of kinds)
      await as("tmember", (tx, r) => addLink(tx, r, { id, targetKind: kind, targetId: targetIds()[kind] }));
    const filters = {
      task: { taskId },
      run: { runId },
      sdlc_item: { sdlcItemId: itemId },
      doc: { docId: teamDocId },
    };
    for (const kind of kinds) {
      const { items } = await as("tmember", (tx, r) => listArtifacts(tx, r, { ...filters[kind], limit: 100 }));
      expect(items.map((i) => i.id)).toContain(id);
      expect(items.map((i) => i.id)).not.toContain(other);
      const outsider = await as("loner", (tx, r) => listArtifacts(tx, r, { ...filters[kind], limit: 100 }));
      expect(outsider.items).toEqual([]);
    }
  });
});

describe("dọn liên kết", () => {
  const existingTasks = async (tx: Tx, ids: string[]) => (await targets.task.existing?.(tx, ids)) ?? new Set<string>();

  it("existing chỉ trả đích còn tồn tại, và job dọn bỏ liên kết tới task đã xoá", async () => {
    const gone = await seedTask("Sẽ bị xoá");
    const id = await projectArtifact("Gắn vào task sắp mất");
    for (const task of [taskId, gone])
      await as("tmember", (tx, r) => addLink(tx, r, { id, targetKind: "task", targetId: task }));
    expect(await as("tmember", (tx) => existingTasks(tx, [taskId, gone, randomUUID()]))).toEqual(
      new Set([taskId, gone]),
    );

    await admin.query("delete from hive.tasks where id = $1", [gone]);
    expect(await as("tmember", (tx) => existingTasks(tx, [taskId, gone]))).toEqual(new Set([taskId]));
    const result = await purgeArtifacts(app);
    expect(result.orphanLinks).toBeGreaterThanOrEqual(1);
    const left = await as("tmember", (tx, r) => listLinks(tx, r, { id }));
    expect(left.map((l) => l.targetId)).toEqual([taskId]);
  });
});
