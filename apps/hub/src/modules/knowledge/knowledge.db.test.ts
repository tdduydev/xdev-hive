import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Tx, withTenant } from "../platform/index.ts";
import type { Principal } from "./access.ts";
import { docHistory, getDoc, listDocs, saveDoc } from "./docs.ts";
import { listMemories, searchMemory, supersedeMemory, writeMemory } from "./memory.ts";
import { approveProposal, createProposal, listProposals, proposeDoc, rejectProposal } from "./proposals.ts";
import { docs, docVersions, memories, proposals, skills, skillVersions } from "./schema.ts";
import { getSkill, listSkills, saveSkill } from "./skills.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);

type Fixture = OrgFixture & { user: (n: string) => string };
let org: Fixture;
let other: Fixture;
/** Dự án của đội Thanh toán, dự án thứ hai cùng đội, và dự án của đội CRM. */
let project = { id: "", key: "" };
let sibling = { id: "", key: "" };
let crmProject = { id: "", key: "" };

const user = (who: string): Principal => ({ kind: "user", userId: org.user(who) });
const run = (projectId = project.id): Principal => ({ kind: "run", runId: randomUUID(), projectId });
/** Chạy fn trong tenant của tổ chức, với người dùng (nếu là người) như middleware inOrg làm. */
function as<T>(p: Principal | string, fn: (tx: Tx, p: Principal) => Promise<T>, o: Fixture = org): Promise<T> {
  const principal = typeof p === "string" ? user(p) : p;
  const userId = principal.kind === "user" ? principal.userId : undefined;
  return withTenant(app, { userId, orgId: o.orgId }, (tx) => fn(tx, principal));
}

async function seedProject(o: Fixture, teamId: string, systemId: string, key: string) {
  const conn = (
    await admin.query(
      `insert into hive.scm_connections (org_id, kind, name, secret_enc, created_by)
       values ($1, 'github', $2, 'x', 'seed') returning id`,
      [o.orgId, `gh-${key}`],
    )
  ).rows[0].id;
  const id = (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
         repo_owner, repo_name, state, settings, idempotency_key, created_by)
       values ($1, $2, $3, $4, $4, $5, 'github', 'new', 'xdev', $4, 'active', '{}', gen_random_uuid(), 'seed')
       returning id`,
      [o.orgId, teamId, systemId, key, conn],
    )
  ).rows[0].id as string;
  return { id, key };
}

beforeAll(async () => {
  org = await seedOrg(admin, "kn");
  other = await seedOrg(admin, "kn2");
  const suffix = org.orgId.slice(0, 6);
  project = await seedProject(org, org.teamId, org.systemId, `thanh-toan-${suffix}`);
  sibling = await seedProject(org, org.teamId, org.systemId, `hoa-don-${suffix}`);
  crmProject = await seedProject(org, org.otherTeamId, org.otherSystemId, `crm-${suffix}`);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const projectScope = () => ({ level: "project" as const, projectId: project.id });
const teamScope = () => ({ level: "team" as const, teamId: org.teamId });
const contents = (rows: Array<{ content: string }>) => rows.map((r) => r.content);

describe("RLS các bảng tri thức", () => {
  beforeAll(async () => {
    await as("tadmin", (tx, p) =>
      saveDoc(tx, p, { key: `project/${project.key}/rls`, content: "# RLS", baseVersion: 0 }),
    );
    await as("tadmin", (tx, p) =>
      saveSkill(tx, p, { scope: teamScope(), name: "rls-skill", description: "Thử RLS", content: "x", baseVersion: 0 }),
    );
    await as("tmember", (tx, p) => writeMemory(tx, p, { scope: teamScope(), kind: "note", content: "Thử RLS" }));
    await as("tmember", (tx, p) =>
      proposeDoc(tx, p, { key: `project/${project.key}/rls`, content: "# RLS 2", baseVersion: 1 }),
    );
  });

  const tables = { memories, docs, docVersions, skills, skillVersions, proposals };

  it("không có tenant context thì mọi bảng trả 0 dòng", async () => {
    await withTenant(app, {}, async (tx) => {
      for (const t of Object.values(tables)) expect(await tx.select().from(t)).toHaveLength(0);
    });
  });

  it("tổ chức khác không thấy dòng nào", async () => {
    await withTenant(app, { userId: other.user("owner"), orgId: other.orgId }, async (tx) => {
      for (const t of Object.values(tables)) expect(await tx.select().from(t)).toHaveLength(0);
    });
  });

  it("không ghi được dòng mang org_id của tổ chức khác", async () => {
    const code = await pgCode(() =>
      as("owner", (tx) =>
        tx.insert(memories).values({ orgId: other.orgId, kind: "note", content: "lạc", authorUserId: "x" }),
      ),
    );
    expect(code).toBe("42501");
  });

  it("UPDATE không chuyển được dòng sang tổ chức khác", async () => {
    for (const t of [memories, docs, skills, proposals]) {
      const code = await pgCode(() => as("owner", (tx) => tx.update(t).set({ orgId: other.orgId })));
      expect(code).toBe("42501");
    }
  });

  it("phiên bản là lịch sử: hive_app không sửa, không xoá được", async () => {
    for (const t of [docVersions, skillVersions]) {
      expect(await pgCode(() => as("owner", (tx) => tx.update(t).set({ content: "đè" })))).toBe("42501");
      expect(await pgCode(() => as("owner", (tx) => tx.delete(t)))).toBe("42501");
    }
  });

  it("mục của dự án không trỏ được sang đội khác với đội của dự án", async () => {
    const code = await pgCode(() =>
      as("owner", (tx) =>
        tx.insert(memories).values({
          orgId: org.orgId,
          teamId: org.otherTeamId,
          projectId: project.id,
          kind: "note",
          content: "lệch đội",
          authorUserId: "x",
        }),
      ),
    );
    expect(code).toBe("23503");
  });

  it("database chặn memory dài quá 2000 ký tự", async () => {
    const code = await pgCode(() =>
      admin.query(
        "insert into hive.memories (org_id, kind, content, author_user_id) values ($1, 'note', repeat('a', 2001), 'x')",
        [org.orgId],
      ),
    );
    expect(code).toBe("23514");
  });
});

describe("memory: ghi và phân quyền", () => {
  it("thành viên đội ghi được memory của dự án; người xem thì không", async () => {
    const m = await as("tmember", (tx, p) =>
      writeMemory(tx, p, {
        scope: projectScope(),
        kind: "gotcha",
        content: "Webhook GitHub gửi lại khi timeout 10 giây",
      }),
    );
    expect(m.scope).toEqual({ level: "project", teamId: org.teamId, projectId: project.id });
    expect(m.author).toEqual({ userId: org.user("tmember"), runId: null });
    expect(
      await errorCode(() =>
        as("tviewer", (tx, p) => writeMemory(tx, p, { scope: projectScope(), kind: "note", content: "x" })),
      ),
    ).toBe("TEAM_ROLE_REQUIRED");
  });

  it("người ngoài đội không thấy dự án nên báo không tìm thấy", async () => {
    expect(
      await errorCode(() =>
        as("oadmin", (tx, p) => writeMemory(tx, p, { scope: projectScope(), kind: "note", content: "x" })),
      ),
    ).toBe("PROJECT_NOT_FOUND");
  });

  it("memory cấp tổ chức cần quản trị tổ chức", async () => {
    const write = (who: string) =>
      as(who, (tx, p) =>
        writeMemory(tx, p, { scope: { level: "org" }, kind: "convention", content: "Commit tiếng Việt" }),
      );
    expect(await errorCode(() => write("tadmin"))).toBe("ORG_ROLE_REQUIRED");
    expect((await write("admin")).scope.level).toBe("org");
  });

  it("nội dung quá 2000 ký tự bị từ chối trước khi tới database", async () => {
    await expect(
      as("tmember", (tx, p) => writeMemory(tx, p, { scope: teamScope(), kind: "note", content: "a".repeat(2001) })),
    ).rejects.toThrow(/2000/);
  });

  it("run ghi memory mặc định vào dự án của run, không ghi được cấp tổ chức", async () => {
    const r = run();
    const m = await as(r, (tx, p) => writeMemory(tx, p, { kind: "decision", content: "Run ghi quyết định" }));
    expect(m.scope.projectId).toBe(project.id);
    expect(m.author.runId).toBe(r.kind === "run" ? r.runId : null);
    expect(
      await errorCode(() =>
        as(run(), (tx, p) => writeMemory(tx, p, { scope: { level: "org" }, kind: "note", content: "x" })),
      ),
    ).toBe("RUN_NOT_ALLOWED");
    expect(
      await errorCode(() =>
        as(run(), (tx, p) =>
          writeMemory(tx, p, { scope: { level: "project", projectId: crmProject.id }, kind: "note", content: "x" }),
        ),
      ),
    ).toBe("PROJECT_NOT_FOUND");
  });

  it("memory.write ghi audit", async () => {
    const m = await as("tmember", (tx, p) =>
      writeMemory(tx, p, { scope: teamScope(), kind: "note", content: "Có audit" }),
    );
    const { rows } = await admin.query("select action, actor_user_id from hive.audit_log where target_id = $1", [m.id]);
    expect(rows).toEqual([{ action: "memory.write", actor_user_id: org.user("tmember") }]);
  });
});

describe("memory.search: full-text tiếng Việt", () => {
  let queue = "";
  let crm = "";
  let siblingNote = "";
  beforeAll(async () => {
    queue = (
      await as("tmember", (tx, p) =>
        writeMemory(tx, p, {
          scope: projectScope(),
          kind: "decision",
          content: "Dùng Postgres làm hàng đợi bằng pg-boss, không dùng Redis.",
          files: ["apps/hub/src/modules/platform/jobs.ts"],
        }),
      )
    ).id;
    await as("tmember", (tx, p) =>
      writeMemory(tx, p, {
        scope: teamScope(),
        kind: "convention",
        content: "Kiến Trúc mô-đun: chỉ import qua index.ts",
      }),
    );
    siblingNote = (
      await as("tmember", (tx, p) =>
        writeMemory(tx, p, {
          scope: { level: "project", projectId: sibling.id },
          kind: "note",
          content: "Hàng đợi hoá đơn chạy lúc nửa đêm",
        }),
      )
    ).id;
    crm = (
      await as("oadmin", (tx, p) =>
        writeMemory(tx, p, {
          scope: { level: "team", teamId: org.otherTeamId },
          kind: "note",
          content: "Hàng đợi CRM",
        }),
      )
    ).id;
  });

  const search = (who: Principal | string, query: string, extra: { project?: string } = {}) =>
    as(who, (tx, p) => searchMemory(tx, p, { query, limit: 20, ...extra }));

  it("tìm được từ có dấu, không phân biệt hoa thường", async () => {
    const hits = await search("tmember", "hàng đợi");
    expect(hits.find((h) => h.id === queue)?.matchedBy).toEqual(["text"]);
    expect(contents(await search("tmember", "kiến trúc"))).toContain("Kiến Trúc mô-đun: chỉ import qua index.ts");
  });

  it("câu tìm dạng NFD (macOS) vẫn khớp nội dung NFC", async () => {
    const hits = await search("tmember", "hàng đợi".normalize("NFD"));
    expect(hits.map((h) => h.id)).toContain(queue);
  });

  it("khớp tiền tố và xếp memory khớp nhiều từ lên trước", async () => {
    expect((await search("tmember", "postg")).map((h) => h.id)).toContain(queue);
    const hits = await search("tmember", "hàng đợi pg-boss redis");
    expect(hits[0]?.id).toBe(queue);
  });

  it("chỉ trả memory người gọi thấy được", async () => {
    const mine = (await search("tmember", "hàng đợi")).map((h) => h.id);
    expect(mine).not.toContain(crm);
    const theirs = (await search("oadmin", "hàng đợi")).map((h) => h.id);
    expect(theirs).toEqual([crm]);
    expect(await search("loner", "hàng đợi")).toEqual([]);
    // Quản trị tổ chức là quản trị mọi đội.
    expect((await search("owner", "hàng đợi")).map((h) => h.id)).toEqual(expect.arrayContaining([queue, crm]));
  });

  it("lọc theo dự án: memory của dự án, của đội và của tổ chức, không lấy dự án khác", async () => {
    const ids = (await search("tmember", "hàng đợi", { project: project.key })).map((h) => h.id);
    expect(ids).toContain(queue);
    expect(ids).not.toContain(siblingNote);
    const byId = (await search("tmember", "hàng đợi", { project: sibling.id })).map((h) => h.id);
    expect(byId).toEqual([siblingNote]);
  });

  it("run chỉ thấy dự án của nó, đội và tổ chức", async () => {
    const ids = (await search(run(), "hàng đợi")).map((h) => h.id);
    expect(ids).toContain(queue);
    expect(ids).not.toContain(siblingNote);
    expect(ids).not.toContain(crm);
    expect(await errorCode(() => search(run(), "hàng đợi", { project: sibling.key }))).toBe("PROJECT_NOT_FOUND");
  });

  it("câu tìm không có chữ thì không có kết quả", async () => {
    expect(await search("tmember", "!!! ...")).toEqual([]);
  });

  it("memory đã bị thay không còn trong kết quả tìm, chỉ hiện khi list kèm includeSuperseded", async () => {
    const old = await as("tmember", (tx, p) =>
      writeMemory(tx, p, { scope: teamScope(), kind: "convention", content: "Nhánh đặt tên kiểu cũ: feature/x" }),
    );
    const next = await as("tmember", (tx, p) =>
      supersedeMemory(tx, p, { id: old.id, content: "Nhánh đặt tên kiểu mới: feat/<mã>" }),
    );
    expect(next.kind).toBe("convention");
    const ids = (await search("tmember", "nhánh đặt tên")).map((h) => h.id);
    expect(ids).toContain(next.id);
    expect(ids).not.toContain(old.id);
    expect(
      await errorCode(() => as("tmember", (tx, p) => supersedeMemory(tx, p, { id: old.id, content: "lần hai" }))),
    ).toBe("MEMORY_SUPERSEDED");
    expect(await errorCode(() => as("tviewer", (tx, p) => supersedeMemory(tx, p, { id: next.id, content: "x" })))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    const listed = await as("tmember", (tx, p) => listMemories(tx, p, { includeSuperseded: true, limit: 200 }));
    expect(listed.find((m) => m.id === old.id)?.supersededBy).toBe(next.id);
    const current = await as("tmember", (tx, p) => listMemories(tx, p, { limit: 200 }));
    expect(current.map((m) => m.id)).not.toContain(old.id);
  });
});

describe("tài liệu: phiên bản và xung đột", () => {
  const key = () => `project/${project.key}/kien-truc`;

  it("quản trị đội tạo rồi sửa; lưu từ base cũ thì CONFLICT", async () => {
    const v1 = await as("tadmin", (tx, p) =>
      saveDoc(tx, p, { key: key(), title: "Kiến trúc", content: "# Kiến trúc\n\nBản đầu.", baseVersion: 0 }),
    );
    expect(v1.version).toBe(1);
    expect(v1.scope).toEqual({ level: "project", teamId: org.teamId, projectId: project.id });
    const v2 = await as("tadmin", (tx, p) =>
      saveDoc(tx, p, { key: key(), content: "# Kiến trúc\n\nBản hai.", baseVersion: 1, message: "Thêm mục" }),
    );
    expect(v2.version).toBe(2);
    expect(v2.title).toBe("Kiến trúc");
    for (const baseVersion of [1, 0, 5]) {
      expect(
        await errorCode(() => as("tadmin", (tx, p) => saveDoc(tx, p, { key: key(), content: "đè", baseVersion }))),
      ).toBe("VERSION_CONFLICT");
    }
    const latest = await as("tviewer", (tx, p) => getDoc(tx, p, { key: key() }));
    expect([latest.version, latest.content]).toEqual([2, "# Kiến trúc\n\nBản hai."]);
    const first = await as("tviewer", (tx, p) => getDoc(tx, p, { key: key(), version: 1 }));
    expect(first.content).toBe("# Kiến trúc\n\nBản đầu.");
    const history = await as("tviewer", (tx, p) => docHistory(tx, p, { key: key() }));
    expect(history.map((h) => [h.version, h.message])).toEqual([
      [2, "Thêm mục"],
      [1, null],
    ]);
  });

  it("hai người cùng sửa từ một bản: người lưu sau nhận CONFLICT", async () => {
    const k = `project/${project.key}/dong-thoi`;
    await as("tadmin", (tx, p) => saveDoc(tx, p, { key: k, content: "gốc", baseVersion: 0 }));
    const results = await Promise.allSettled(
      ["tadmin", "owner"].map((who) => as(who, (tx, p) => saveDoc(tx, p, { key: k, content: who, baseVersion: 1 }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.code).toBe("VERSION_CONFLICT");
  });

  it("thành viên và run không lưu trực tiếp; người ngoài đội không thấy", async () => {
    const save = (who: Principal | string) =>
      as(who, (tx, p) => saveDoc(tx, p, { key: key(), content: "x", baseVersion: 2 }));
    expect(await errorCode(() => save("tmember"))).toBe("TEAM_ROLE_REQUIRED");
    expect(await errorCode(() => save(run()))).toBe("RUN_NOT_ALLOWED");
    expect(await errorCode(() => as("oadmin", (tx, p) => getDoc(tx, p, { key: key() })))).toBe("DOC_NOT_FOUND");
    expect(await errorCode(() => as("loner", (tx, p) => getDoc(tx, p, { key: key() })))).toBe("DOC_NOT_FOUND");
  });

  it("tài liệu cấp tổ chức: quản trị tổ chức lưu, mọi thành viên đọc", async () => {
    const k = "org/quy-uoc/commit";
    expect(
      await errorCode(() => as("tadmin", (tx, p) => saveDoc(tx, p, { key: k, content: "x", baseVersion: 0 }))),
    ).toBe("ORG_ROLE_REQUIRED");
    await as("admin", (tx, p) => saveDoc(tx, p, { key: k, content: "Commit viết tiếng Việt.", baseVersion: 0 }));
    expect((await as("loner", (tx, p) => getDoc(tx, p, { key: k }))).content).toBe("Commit viết tiếng Việt.");
    expect((await as(run(), (tx, p) => getDoc(tx, p, { key: k }))).scope.level).toBe("org");
  });

  it("tài liệu của đội theo slug; đội không có thì NOT_FOUND", async () => {
    const d = await as("tadmin", (tx, p) =>
      saveDoc(tx, p, { key: "team/thanh-toan/quy-trinh", content: "Quy trình", baseVersion: 0 }),
    );
    expect(d.scope).toEqual({ level: "team", teamId: org.teamId, projectId: null });
    expect(
      await errorCode(() =>
        as("owner", (tx, p) => saveDoc(tx, p, { key: "team/khong-co/x", content: "x", baseVersion: 0 })),
      ),
    ).toBe("TEAM_NOT_FOUND");
  });

  it("list theo dự án và tiền tố", async () => {
    const all = await as("tviewer", (tx, p) => listDocs(tx, p, { project: project.key }));
    expect(all.map((d) => d.key)).toEqual(
      expect.arrayContaining([key(), "org/quy-uoc/commit", "team/thanh-toan/quy-trinh"]),
    );
    const prefixed = await as("tviewer", (tx, p) => listDocs(tx, p, { prefix: `project/${project.key}/kien` }));
    expect(prefixed.map((d) => d.key)).toEqual([key()]);
    // `_` trong tiền tố là ký tự thường, không phải ký tự đại diện của LIKE.
    expect(await as("tviewer", (tx, p) => listDocs(tx, p, { prefix: "org_" }))).toEqual([]);
  });
});

describe("skill: phạm vi và tên trùng", () => {
  beforeAll(async () => {
    await as("admin", (tx, p) =>
      saveSkill(tx, p, {
        scope: { level: "org" },
        name: "review-code",
        description: "Review chung",
        content: "---\nname: review-code\n---\nBản tổ chức",
        baseVersion: 0,
      }),
    );
    await as("tadmin", (tx, p) =>
      saveSkill(tx, p, {
        scope: projectScope(),
        name: "review-code",
        description: "Review cho dự án thanh toán",
        content: "Bản dự án",
        baseVersion: 0,
      }),
    );
  });

  it("trong dự án, skill của dự án che skill cùng tên của tổ chức", async () => {
    const list = await as("tviewer", (tx, p) => listSkills(tx, p, { project: project.key }));
    expect(list.filter((s) => s.name === "review-code").map((s) => s.scope.level)).toEqual(["project"]);
    expect((await as(run(), (tx, p) => getSkill(tx, p, { name: "review-code" }))).content).toBe("Bản dự án");
    expect((await as(run(sibling.id), (tx, p) => getSkill(tx, p, { name: "review-code" }))).content).toContain(
      "Bản tổ chức",
    );
    expect((await as("loner", (tx, p) => getSkill(tx, p, { name: "review-code" }))).scope.level).toBe("org");
  });

  it("không có dự án thì list trả mọi skill mình thấy", async () => {
    const list = await as("tviewer", (tx, p) => listSkills(tx, p, {}));
    expect(list.filter((s) => s.name === "review-code")).toHaveLength(2);
    expect((await as("loner", (tx, p) => listSkills(tx, p, {}))).every((s) => s.scope.level === "org")).toBe(true);
  });

  it("thành viên không lưu được, base cũ thì CONFLICT, đọc lại phiên bản cũ được", async () => {
    const input = { scope: projectScope(), name: "review-code", description: "d", content: "Bản dự án 2" };
    expect(await errorCode(() => as("tmember", (tx, p) => saveSkill(tx, p, { ...input, baseVersion: 1 })))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    const v2 = await as("tadmin", (tx, p) => saveSkill(tx, p, { ...input, baseVersion: 1 }));
    expect(v2.version).toBe(2);
    expect(await errorCode(() => as("tadmin", (tx, p) => saveSkill(tx, p, { ...input, baseVersion: 1 })))).toBe(
      "VERSION_CONFLICT",
    );
    expect(await errorCode(() => as("tadmin", (tx, p) => saveSkill(tx, p, { ...input, baseVersion: 0 })))).toBe(
      "VERSION_CONFLICT",
    );
    const v1 = await as("tviewer", (tx, p) => getSkill(tx, p, { id: v2.id, version: 1 }));
    expect(v1.content).toBe("Bản dự án");
    expect(await errorCode(() => as("oadmin", (tx, p) => getSkill(tx, p, { id: v2.id })))).toBe("SKILL_NOT_FOUND");
  });
});

describe("đề xuất: tạo, duyệt, từ chối", () => {
  const key = () => `project/${project.key}/huong-dan`;

  beforeAll(async () => {
    await as("tadmin", (tx, p) => saveDoc(tx, p, { key: key(), content: "Bản 1", baseVersion: 0 }));
  });

  it("thành viên đề xuất, quản trị đội duyệt thành phiên bản mới", async () => {
    const prop = await as("tmember", (tx, p) =>
      createProposal(tx, p, {
        kind: "doc",
        key: key(),
        content: "Bản 2 từ đề xuất",
        baseVersion: 1,
        reason: "Bổ sung",
      }),
    );
    expect(prop.status).toBe("pending");
    expect(await errorCode(() => as("tmember", (tx, p) => approveProposal(tx, p, { id: prop.id })))).toBe(
      "TEAM_ROLE_REQUIRED",
    );
    const approved = await as("tadmin", (tx, p) => approveProposal(tx, p, { id: prop.id, note: "Hợp lý" }));
    expect(approved).toMatchObject({
      status: "approved",
      resultVersion: 2,
      decidedBy: org.user("tadmin"),
      decisionNote: "Hợp lý",
    });
    const doc = await as("tviewer", (tx, p) => getDoc(tx, p, { key: key() }));
    expect([doc.version, doc.content]).toEqual([2, "Bản 2 từ đề xuất"]);
    const history = await as("tviewer", (tx, p) => docHistory(tx, p, { key: key() }));
    expect(history[0]?.proposalId).toBe(prop.id);
    expect(await errorCode(() => as("tadmin", (tx, p) => approveProposal(tx, p, { id: prop.id })))).toBe(
      "PROPOSAL_DECIDED",
    );
    const { rows } = await admin.query("select action from hive.audit_log where target_id = $1 order by created_at", [
      prop.id,
    ]);
    expect(rows.map((r) => r.action)).toEqual(["proposal.create", "proposal.approve"]);
  });

  it("đề xuất trên base đã cũ bị từ chối ngay khi tạo", async () => {
    expect(
      await errorCode(() =>
        as("tmember", (tx, p) => createProposal(tx, p, { kind: "doc", key: key(), content: "x", baseVersion: 1 })),
      ),
    ).toBe("VERSION_CONFLICT");
  });

  it("hai đề xuất cùng base: duyệt cái sau thì CONFLICT, đề xuất vẫn chờ để từ chối", async () => {
    const a = await as("tmember", (tx, p) => proposeDoc(tx, p, { key: key(), content: "A", baseVersion: 2 }));
    const b = await as(run(), (tx, p) => proposeDoc(tx, p, { key: key(), content: "B", baseVersion: 2 }));
    expect(b.author.runId).not.toBeNull();
    await as("tadmin", (tx, p) => approveProposal(tx, p, { id: a.id }));
    expect(await errorCode(() => as("tadmin", (tx, p) => approveProposal(tx, p, { id: b.id })))).toBe(
      "VERSION_CONFLICT",
    );
    const pending = await as("tadmin", (tx, p) => listProposals(tx, p, { status: "pending", project: project.key }));
    expect(pending.map((x) => x.id)).toContain(b.id);
    const rejected = await as("tadmin", (tx, p) => rejectProposal(tx, p, { id: b.id, note: "Đã có bản mới" }));
    expect(rejected).toMatchObject({ status: "rejected", resultVersion: null });
    expect((await as("tviewer", (tx, p) => getDoc(tx, p, { key: key() }))).content).toBe("A");
  });

  it("người xem không đề xuất được; người ngoài đội không thấy đề xuất", async () => {
    expect(
      await errorCode(() => as("tviewer", (tx, p) => proposeDoc(tx, p, { key: key(), content: "x", baseVersion: 3 }))),
    ).toBe("TEAM_ROLE_REQUIRED");
    expect(await as("oadmin", (tx, p) => listProposals(tx, p, {}))).toEqual([]);
    const [any] = await as("tadmin", (tx, p) => listProposals(tx, p, { kind: "doc" }));
    expect(await errorCode(() => as("oadmin", (tx, p) => rejectProposal(tx, p, { id: any?.id ?? "" })))).toBe(
      "PROPOSAL_NOT_FOUND",
    );
  });

  it("run không duyệt được; đề xuất tài liệu tổ chức thì thành viên nào cũng tạo được", async () => {
    await as("admin", (tx, p) => saveDoc(tx, p, { key: "org/huong-dan/agent", content: "v1", baseVersion: 0 }));
    const prop = await as("loner", (tx, p) =>
      proposeDoc(tx, p, { key: "org/huong-dan/agent", content: "v2", baseVersion: 1 }),
    );
    expect(await errorCode(() => as(run(), (tx, p) => approveProposal(tx, p, { id: prop.id })))).toBe(
      "RUN_NOT_ALLOWED",
    );
    expect(await errorCode(() => as("tadmin", (tx, p) => approveProposal(tx, p, { id: prop.id })))).toBe(
      "ORG_ROLE_REQUIRED",
    );
    expect((await as("owner", (tx, p) => approveProposal(tx, p, { id: prop.id }))).resultVersion).toBe(2);
  });

  it("đề xuất skill mới, duyệt thì tạo skill", async () => {
    const prop = await as(run(), (tx, p) =>
      createProposal(tx, p, {
        kind: "skill",
        scope: teamScope(),
        name: "viet-test",
        description: "Cách viết test của đội",
        content: "Viết test có database bằng Testcontainers.",
        baseVersion: 0,
      }),
    );
    await as("tadmin", (tx, p) => approveProposal(tx, p, { id: prop.id }));
    const s = await as("tviewer", (tx, p) => getSkill(tx, p, { name: "viet-test", project: project.key }));
    expect([s.version, s.description, s.scope.level]).toEqual([1, "Cách viết test của đội", "team"]);
  });
});
