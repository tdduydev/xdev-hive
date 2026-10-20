import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { seedOrg } from "../../../../test/org-fixture.ts";
import { seedProject } from "../../../../test/project-fixture.ts";
import { saveDoc } from "../../knowledge/index.ts";
import { createPool, ForbiddenError, type Jobs, parseMasterKey, withTenant } from "../../platform/index.ts";
import { createMemoryProvider } from "../../scm/index.ts";
import { configureProjectHome, type HomeRow } from "../homes.ts";
import { docWordImportFiles } from "../schema.ts";
import { commitWordImport } from "./commit.ts";
import { confirmLink, linkComparable, prepareLink } from "./link.ts";
import { frontMatter } from "./postprocess.ts";

// Test chèn file `ready` thẳng vào bảng, không cần job chuyển (T009) hay pandoc.
const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const pool = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);
const mem = createMemoryProvider("gitlab", ["xdev-team"]);
const jobs = { enqueue: async () => randomUUID() } as unknown as Jobs;
const deps = { pool, jobs, masterKey, providerFactory: () => mem, publicUrl: "https://hive.example" };
const projectKey = `wl${tag}`;
const IMAGE = "a1b2c3d4e5f6.png";

let org: Awaited<ReturnType<typeof seedOrg>>;
let project: Awaited<ReturnType<typeof seedProject>>;
let home: HomeRow;
const actor = (name: string) => ({ userId: org.user(name), orgId: org.orgId });
const as = <T>(name: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, actor(name), fn);
const user = (name: string) => ({ kind: "user" as const, userId: org.user(name) });
const key = (name: string) => `project/${projectKey}/srs/${name}`;
const converted = (body: string) =>
  frontMatter({ title: "OPD02", file: "OPD02.docx", sha256: "f".repeat(64), confidential: false }) + body;

/** Tài liệu có sẵn và lượt `link` có một file đã chuyển xong. */
async function seedLink(name: string, current: string, markdown: string) {
  const doc = await as("tadmin", (tx) =>
    saveDoc(tx, user("tadmin"), { key: key(name), content: current, baseVersion: 0 }),
  );
  const { rows } = await admin.query(
    `insert into hive.doc_word_imports (org_id, home_id, mode, update_doc_id, state, created_by)
     values ($1, $2, 'link', $3, 'converting', $4) returning id`,
    [org.orgId, home.id, doc.id, org.user("tadmin")],
  );
  const importId: string = rows[0].id;
  const file = await admin.query(
    `insert into hive.doc_word_import_files (org_id, import_id, file_name, format, size, sha256, state, markdown)
     values ($1, $2, $3, 'docx', 100, $4, 'ready', $5) returning id`,
    [org.orgId, importId, `${name}.docx`, "f".repeat(64), markdown],
  );
  return { doc, importId, fileId: file.rows[0].id as string };
}

/** Như job chuyển gọi sau khi file `ready`. */
const prepare = (fileId: string) =>
  as("tadmin", async (tx) => {
    const [file] = await tx.select().from(docWordImportFiles).where(eq(docWordImportFiles.id, fileId));
    if (!file) throw new Error("thiếu file");
    await prepareLink(tx, file);
  });
const fileRow = async (id: string) =>
  (await admin.query("select * from hive.doc_word_import_files where id = $1", [id])).rows[0];
const importRow = async (id: string) =>
  (await admin.query("select * from hive.doc_word_imports where id = $1", [id])).rows[0];
const docState = async (docId: string) =>
  (await admin.query("select current_version from hive.docs where id = $1", [docId])).rows[0];
const assetCount = async () =>
  (await admin.query("select count(*)::int as n from hive.doc_assets where home_id = $1", [home.id])).rows[0].n;

beforeAll(async () => {
  org = await seedOrg(admin, `dwl-${tag}`);
  project = await seedProject(admin, pool, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  mem.seedRepo({ owner: project.owner, name: project.repo }, { files: { "README.md": "# Repo\n" } });
  home = await as("tadmin", (tx) =>
    configureProjectHome(tx, deps, actor("tadmin"), {
      project: projectKey,
      settings: {
        enabled: true,
        root: "docs/",
        repoSync: "direct",
        include: ["**/*.md"],
        exclude: [],
        assetsDir: "assets",
        repoChangesNeedReview: false,
        wordImportConfidential: false,
      },
    }),
  );
});

afterAll(async () => {
  await Promise.all([admin.end(), pool.end()]);
});

describe("dạng để so", () => {
  it("bỏ front matter, chuẩn link ảnh về tên ảnh, bỏ khoảng trắng cuối dòng và CRLF", () => {
    const current = `---\ntitle: "Cũ"\n---\n\n# OPD02  \r\n\r\n![logo](../assets/${IMAGE})\r\n\r\n`;
    const fresh = converted(`# OPD02\n\n![logo](${IMAGE})\n`);
    expect(linkComparable(current)).toBe(`# OPD02\n\n![logo](${IMAGE})`);
    expect(linkComparable(fresh)).toBe(linkComparable(current));
    expect(linkComparable("# A\n\nkhác\n")).not.toBe(linkComparable("# A\n\nkhac\n"));
  });
});

describe("gắn tài liệu có sẵn với file Word (US6)", () => {
  it("khớp thì file xong, không tạo phiên bản và không ghi ảnh", async () => {
    const assets = await assetCount();
    const { doc, importId, fileId } = await seedLink(
      "khop",
      `# OPD02\n\n![logo](../../assets/${IMAGE})\n`,
      converted(`# OPD02\n\n![logo](${IMAGE})\n`),
    );
    await prepare(fileId);
    expect(await fileRow(fileId)).toMatchObject({
      state: "done",
      link_matches: true,
      doc_id: doc.id,
      doc_version: null,
    });
    expect(await docState(doc.id)).toEqual({ current_version: 1 });
    expect(await assetCount()).toBe(assets);
    expect(await importRow(importId)).toMatchObject({ state: "done", counts: expect.objectContaining({ done: 1 }) });
  });

  it("không khớp thì chờ người gắn xác nhận, xác nhận ghi audit", async () => {
    const { doc, importId, fileId } = await seedLink(
      "lech",
      "# OPD03\n\nBản trên hub đã sửa.\n",
      converted("# OPD03\n\nBản trong Word.\n"),
    );
    await prepare(fileId);
    expect(await fileRow(fileId)).toMatchObject({ state: "ready", link_matches: false, doc_id: null });
    expect((await importRow(importId)).state).toBe("converting");

    // Tạo (commit) không đụng tới lượt gắn: chỉ confirmLink mới chọn bản chuyển làm gốc.
    await as("tadmin", (tx) => commitWordImport(tx, deps, user("tadmin"), { importId }));
    expect((await fileRow(fileId)).state).toBe("ready");

    const view = await as("tadmin", (tx) => confirmLink(tx, user("tadmin"), { fileId }));
    expect(view).toMatchObject({
      state: "done",
      linkMatches: false,
      docId: doc.id,
      docVersion: null,
      key: key("lech"),
    });
    expect(await docState(doc.id)).toEqual({ current_version: 1 });
    const { rows } = await admin.query(
      "select actor_user_id, data from hive.audit_log where org_id = $1 and action = 'docs.word_link_confirm' and target_id = $2",
      [org.orgId, doc.id],
    );
    expect(rows).toEqual([
      {
        actor_user_id: org.user("tadmin"),
        data: expect.objectContaining({ importId, fileId, docKey: key("lech"), matches: false }),
      },
    ]);
    expect((await importRow(importId)).state).toBe("done");

    await expect(as("tadmin", (tx) => confirmLink(tx, user("tadmin"), { fileId }))).rejects.toMatchObject({
      code: "WORD_IMPORT_FILE_NOT_READY",
    });
  });

  it("người không có quyền quản lý không xác nhận được", async () => {
    const { fileId } = await seedLink("quyen", "# A\n", converted("# B\n"));
    await prepare(fileId);
    await expect(as("tviewer", (tx) => confirmLink(tx, user("tviewer"), { fileId }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await fileRow(fileId)).state).toBe("ready");
  });

  it("file của lượt tạo hoặc không có thì từ chối", async () => {
    const { rows } = await admin.query(
      `insert into hive.doc_word_imports (org_id, home_id, target_dir, mode, state, created_by)
       values ($1, $2, 'docs/srs', 'create', 'ready', $3) returning id`,
      [org.orgId, home.id, org.user("tadmin")],
    );
    const file = await admin.query(
      `insert into hive.doc_word_import_files (org_id, import_id, file_name, format, size, sha256, state, markdown)
       values ($1, $2, 'C.docx', 'docx', 1, $3, 'ready', '# C\n') returning id`,
      [org.orgId, rows[0].id, "c".repeat(64)],
    );
    await expect(
      as("tadmin", (tx) => confirmLink(tx, user("tadmin"), { fileId: file.rows[0].id })),
    ).rejects.toMatchObject({ code: "WORD_IMPORT_NOT_LINK" });
    await expect(as("tadmin", (tx) => confirmLink(tx, user("tadmin"), { fileId: randomUUID() }))).rejects.toMatchObject(
      {
        code: "WORD_IMPORT_FILE_NOT_FOUND",
      },
    );
  });
});
