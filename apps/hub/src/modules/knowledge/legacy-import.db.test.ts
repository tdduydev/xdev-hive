import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { createPool, type Jobs, withTenant } from "../platform/index.ts";
import { importLegacy } from "./legacy-import.ts";
import { listMemories, runEmbed, searchMemory, supersedeMemory } from "./memory.ts";
import { docs, docVersions, legacyDocAssets, legacyImports, memories, skills, skillVersions } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const fixtureDir = resolve(".legacy", `import-fixtures-${randomUUID()}`);
const createdAt = "2024-01-01T00:00:00.000Z";
const updatedAt = "2024-02-01T00:00:00.000Z";
const skillContent = (description: string) =>
  `---\nname: sample-skill\ndescription: ${description}\n---\n# Hướng dẫn tổng hợp`;

type Fixture = Awaited<ReturnType<typeof setup>>;
let fixture: Fixture;
let other: Fixture;

async function seedProject(org: Awaited<ReturnType<typeof seedOrg>>, key: string) {
  const connection = (
    await admin.query(
      "insert into hive.scm_connections (org_id, kind, name, secret_enc, created_by) values ($1,'github',$2,'fixture','seed') returning id",
      [org.orgId, `fixture-${key}`],
    )
  ).rows[0].id;
  return (
    await admin.query(
      `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
    repo_owner, repo_name, state, settings, idempotency_key, created_by)
    values ($1,$2,$3,$4,$4,$5,'github','new','fixture',$4,'active','{}',gen_random_uuid(),'seed') returning id`,
      [org.orgId, org.teamId, org.systemId, key, connection],
    )
  ).rows[0].id as string;
}

async function setup() {
  const org = await seedOrg(admin, `legacy-${randomUUID()}`);
  const slug = (await admin.query("select slug from hive.orgs where id=$1", [org.orgId])).rows[0].slug as string;
  const projectId = await seedProject(org, "target-app");
  const sameKeyProjectId = await seedProject(org, "source-app");
  const dbPath = resolve(fixtureDir, `${org.orgId}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory(id INTEGER PRIMARY KEY, project TEXT, kind TEXT, content TEXT, author TEXT, status TEXT, created_at TEXT, files TEXT, superseded_by INTEGER, on_behalf TEXT);
    CREATE TABLE docs(key TEXT PRIMARY KEY, scope TEXT, project TEXT, title TEXT, content TEXT, version INTEGER, updated_by TEXT, updated_at TEXT, folder INTEGER, parent TEXT, paths TEXT, removed_at TEXT);
    CREATE TABLE doc_versions(key TEXT, version INTEGER, content TEXT, author TEXT, note TEXT, created_at TEXT, PRIMARY KEY(key,version));
    CREATE TABLE doc_assets(id INTEGER PRIMARY KEY, doc_key TEXT, name TEXT, type TEXT, size INTEGER, uploaded_by TEXT, created_at TEXT, sha256 TEXT, stored TEXT, data BLOB);
    CREATE TABLE hub_users(id TEXT, username TEXT, email TEXT, password_hash TEXT);
    CREATE TABLE tasks(id TEXT, content TEXT);
    CREATE TABLE memory_vectors(memory_id INTEGER, embedding BLOB);
    INSERT INTO tasks VALUES('ignored','Dữ liệu vận hành tổng hợp');
    INSERT INTO memory_vectors VALUES(1,X'010203');
  `);
  const email = `${org.user("tmember")}@seed.test`;
  db.prepare("INSERT INTO hub_users VALUES (?,?,?,?)").run("old-user", "old-author", email, "fixture-not-a-secret");
  const memory = db.prepare("INSERT INTO memory VALUES (?,?,?,?,?,?,?,?,?,?)");
  memory.run(
    1,
    "source-app",
    "decision",
    "Quyết định tổng hợp",
    "old-author",
    "approved",
    createdAt,
    '[{"path":"src/sample.ts","sha":"synthetic"}]',
    2,
    null,
  );
  memory.run(2, "source-app", "context", "Ngữ cảnh tổng hợp", "unknown-agent", "approved", updatedAt, "[]", null, null);
  memory.run(3, "", "note", "Nội dung chờ duyệt", "unknown-agent", "pending", createdAt, "[]", null, null);
  memory.run(4, "", "convention", "😀".repeat(2001), "unknown-agent", "approved", createdAt, "[]", null, email);
  const doc = db.prepare("INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const version = db.prepare("INSERT INTO doc_versions VALUES (?,?,?,?,?,?)");
  doc.run(
    "project/source-app/guide",
    "project",
    "source-app",
    "Tài liệu tổng hợp",
    "# Bản hai\n![Tệp](assets/guide/sample.png)",
    2,
    "old-author",
    updatedAt,
    0,
    null,
    "[]",
    null,
  );
  version.run("project/source-app/guide", 1, "# Bản một", "unknown-agent", "Khởi tạo", createdAt);
  version.run(
    "project/source-app/guide",
    2,
    "# Bản hai\n![Tệp](assets/guide/sample.png)",
    "old-author",
    "Cập nhật",
    updatedAt,
  );
  doc.run(
    "org/skills/sample-skill",
    "org",
    null,
    "Skill tổng hợp",
    skillContent("Bản hai"),
    2,
    "unknown-agent",
    updatedAt,
    0,
    null,
    "[]",
    null,
  );
  version.run("org/skills/sample-skill", 1, skillContent("Bản một"), "unknown-agent", "Khởi tạo", createdAt);
  version.run("org/skills/sample-skill", 2, skillContent("Bản hai"), "old-author", "Cập nhật", updatedAt);
  db.prepare("INSERT INTO doc_assets VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    1,
    "project/source-app/guide",
    "sample.png",
    "image/png",
    3,
    "old-author",
    createdAt,
    "fixture-hash",
    "seaweed-fixture-locator",
    new Uint8Array([1, 2, 3]),
  );
  db.close();
  return { ...org, slug, projectId, sameKeyProjectId, dbPath };
}

const options = (f: Fixture = fixture) => ({
  db: f.dbPath,
  org: f.slug,
  projectMap: new Map([["source-app", "target-app"]]),
});
const tenant = <T>(f: Fixture, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(app, { orgId: f.orgId }, fn);
const editSource = (f: Fixture, fn: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(f.dbPath);
  try {
    fn(db);
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  mkdirSync(fixtureDir, { recursive: true });
  fixture = await setup();
  other = await setup();
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe("import tri thức cũ", () => {
  it("dry-run đếm đúng nhưng không ghi bảng hay gửi embedding", async () => {
    let enqueued = 0;
    const jobs = {
      enqueue: async () => {
        enqueued++;
        return "job";
      },
    } as unknown as Jobs;
    const report = await importLegacy(
      app,
      { ...options(), dryRun: true },
      {
        jobs,
        embedder: {
          model: "fixture",
          embed: async () => {
            throw new Error("Không gọi embedding trong import");
          },
        },
      },
    );
    expect(report.memory).toMatchObject({ added: 4, skipped: 0, errors: 0 });
    expect(report.doc).toMatchObject({ added: 1, errors: 0 });
    expect(report.docVersion.added).toBe(2);
    expect(report.skill.added).toBe(1);
    expect(report.skillVersion.added).toBe(2);
    expect(report.asset.added).toBe(1);
    expect(enqueued).toBe(0);
    await tenant(fixture, async (tx) => {
      for (const table of [memories, docs, docVersions, skills, skillVersions, legacyImports, legacyDocAssets])
        expect(await tx.select().from(table)).toHaveLength(0);
    });
  });

  it("import giữ thời điểm, lịch sử, tác giả, chia memory dài và lưu asset thiếu blob", async () => {
    const report = await importLegacy(app, options());
    expect(Object.values(report).every((c) => c.errors === 0)).toBe(true);
    await tenant(fixture, async (tx) => {
      const rows = await tx.select().from(memories);
      expect(rows).toHaveLength(5);
      const pending = rows.find((r) => r.status === "pending");
      expect(pending?.content).toBe("Nội dung chờ duyệt");
      const principal = { kind: "user" as const, userId: fixture.user("owner") };
      expect(
        (await listMemories(tx, principal, { limit: 100, offset: 0, includeSuperseded: true })).some(
          (m) => m.id === pending?.id,
        ),
      ).toBe(false);
      expect(await searchMemory(tx, principal, { query: "chờ duyệt", limit: 10 })).toHaveLength(0);
      if (pending)
        await expect(supersedeMemory(tx, principal, { id: pending.id, content: "Không tự duyệt" })).rejects.toThrow(
          "Không tìm thấy memory",
        );
      const decision = rows.find((r) => r.kind === "decision");
      expect(decision).toMatchObject({
        projectId: fixture.projectId,
        teamId: fixture.teamId,
        authorUserId: fixture.user("tmember"),
        createdAt: new Date(createdAt),
        files: ["src/sample.ts"],
      });
      const context = rows.find((r) => r.content === "Ngữ cảnh tổng hợp");
      expect(context).toMatchObject({ kind: "note", authorUserId: "hệ cũ" });
      expect(decision?.supersededBy).toBe(context?.id);
      const chunks = rows.filter((r) => r.kind === "convention");
      expect(chunks.map((r) => Array.from(r.content).length).sort((a, b) => a - b)).toEqual([1, 2000]);
      expect(chunks.every((r) => r.authorUserId === fixture.user("tmember"))).toBe(true);
      const [document] = await tx.select().from(docs);
      expect(document).toMatchObject({
        key: "project/target-app/guide",
        currentVersion: 2,
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt),
      });
      const history = await tx.select().from(docVersions).orderBy(docVersions.version);
      expect(history.map((v) => v.version)).toEqual([1, 2]);
      expect(history[0]).toMatchObject({ message: "Khởi tạo", createdAt: new Date(createdAt), authorUserId: "hệ cũ" });
      expect(history[1]?.content).toContain("assets/guide/sample.png");
      expect(history[1]?.content).toContain("chưa được chuyển (1 tệp)");
      expect((await tx.select().from(skillVersions)).map((v) => v.description).sort()).toEqual(["Bản hai", "Bản một"]);
      const [skill] = await tx.select().from(skills);
      expect(skill).toMatchObject({ name: "sample-skill", currentVersion: 2, description: "Bản hai" });
      const [asset] = await tx.select().from(legacyDocAssets);
      expect(asset).toMatchObject({
        name: "sample.png",
        size: 3,
        sha256: "fixture-hash",
        storageLocator: "seaweed-fixture-locator",
        status: "missing",
      });
      const [imported] = await tx.select().from(legacyImports).where(eq(legacyImports.sourceId, "4"));
      expect(imported?.targetIds).toHaveLength(2);
      expect(rows.every((m) => m.embeddingModel === null)).toBe(true);
    });
  });

  it("chạy lại và dry-run sau import không nhân đôi hoặc ghi đè chỉnh sửa đích", async () => {
    await tenant(fixture, (tx) => tx.update(docs).set({ title: "Tên đã sửa ở hub mới" }));
    const report = await importLegacy(app, options());
    const dry = await importLegacy(app, { ...options(), dryRun: true });
    expect(dry).toEqual(report);
    expect(report.memory).toMatchObject({ added: 0, skipped: 4, errors: 0 });
    expect(report.docVersion.skipped).toBe(2);
    expect(report.skillVersion.skipped).toBe(2);
    expect(Object.values(report).every((c) => c.added === 0 && c.errors === 0)).toBe(true);
    await tenant(fixture, async (tx) => {
      expect(await tx.select().from(memories)).toHaveLength(5);
      expect((await tx.select().from(docs))[0]?.title).toBe("Tên đã sửa ở hub mới");
      expect(await tx.select().from(legacyImports)).toHaveLength(7);
    });
  });

  it("RLS không lộ dữ liệu khi thiếu context hoặc sang tổ chức khác, chặn INSERT và UPDATE đổi org", async () => {
    const tables = [memories, docs, docVersions, skills, skillVersions, legacyImports, legacyDocAssets];
    await withTenant(app, {}, async (tx) => {
      for (const t of tables) expect(await tx.select().from(t)).toHaveLength(0);
    });
    await tenant(other, async (tx) => {
      for (const t of tables) expect(await tx.select().from(t)).toHaveLength(0);
    });
    expect(
      await pgCode(() =>
        tenant(fixture, (tx) =>
          tx
            .insert(legacyImports)
            .values({ orgId: other.orgId, kind: "memory", sourceId: "bad", targetIds: [], metadata: {} }),
        ),
      ),
    ).toBe("42501");
    expect(await pgCode(() => tenant(fixture, (tx) => tx.update(legacyImports).set({ orgId: other.orgId })))).toBe(
      "42501",
    );
    expect(await pgCode(() => tenant(fixture, (tx) => tx.update(legacyDocAssets).set({ orgId: other.orgId })))).toBe(
      "42501",
    );
    const [documentImport] = await tenant(fixture, (tx) =>
      tx.select().from(legacyImports).where(eq(legacyImports.kind, "doc")),
    );
    expect(documentImport).toBeDefined();
    expect(
      await pgCode(() =>
        tenant(fixture, (tx) =>
          tx.insert(legacyDocAssets).values({
            orgId: other.orgId,
            documentImportId: documentImport?.id ?? randomUUID(),
            sourceId: "bad",
            name: "fixture",
            mediaType: "text/plain",
            size: 1,
            uploadedBy: "hệ cũ",
            createdAt: new Date(createdAt),
          }),
        ),
      ),
    ).toBe("42501");
    expect(
      await pgCode(() =>
        tenant(other, (tx) =>
          tx.insert(legacyDocAssets).values({
            orgId: other.orgId,
            documentImportId: documentImport?.id ?? randomUUID(),
            sourceId: "bad",
            name: "fixture",
            mediaType: "text/plain",
            size: 1,
            uploadedBy: "hệ cũ",
            createdAt: new Date(createdAt),
          }),
        ),
      ),
    ).toBe("23503");
  });

  it("cùng ID nguồn có thể import độc lập vào tổ chức khác và mặc định ánh xạ theo key", async () => {
    const report = await importLegacy(app, { db: other.dbPath, org: other.slug });
    expect(report.memory.added).toBe(4);
    await tenant(other, async (tx) => {
      const projectRows = (await tx.select().from(memories)).filter((m) => m.projectId !== null);
      expect(projectRows.every((m) => m.projectId === other.sameKeyProjectId && m.orgId === other.orgId)).toBe(true);
      expect((await tx.select().from(docs))[0]?.key).toBe("project/source-app/guide");
    });
  });

  it("dự án thiếu hoặc chỉ tồn tại ở tổ chức khác báo lỗi, không mở rộng thành tri thức cấp tổ chức", async () => {
    const f = await setup();
    await seedProject(other, "foreign-only");
    const dry = await importLegacy(app, {
      ...options(f),
      projectMap: new Map([["source-app", "foreign-only"]]),
      dryRun: true,
    });
    const report = await importLegacy(app, { ...options(f), projectMap: new Map([["source-app", "foreign-only"]]) });
    expect(dry).toEqual(report);
    expect(report.memory).toMatchObject({ added: 2, errors: 2, skipped: 0 });
    expect(report.doc.errors).toBe(1);
    expect(report.docVersion.errors).toBe(2);
    expect(report.asset.errors).toBe(1);
    expect(await tenant(f, (tx) => tx.select().from(memories))).toHaveLength(3);
  });

  it("dữ liệu lỗi, lịch sử không khớp và key đích có sẵn không ghi đè; mục hợp lệ vẫn import", async () => {
    const f = await setup();
    editSource(f, (db) => {
      db.exec(
        "UPDATE memory SET files='invalid-json' WHERE id=1; UPDATE memory SET created_at='invalid-date' WHERE id=2; UPDATE doc_versions SET content='mismatch' WHERE key='org/skills/sample-skill' AND version=2;",
      );
    });
    await tenant(f, (tx) =>
      tx.insert(docs).values({
        orgId: f.orgId,
        key: "project/target-app/guide",
        teamId: f.teamId,
        projectId: f.projectId,
        title: "Giữ lại",
        currentVersion: 1,
        updatedByUserId: "seed",
      }),
    );
    const dry = await importLegacy(app, { ...options(f), dryRun: true });
    const report = await importLegacy(app, options(f));
    expect(dry).toEqual(report);
    expect(report.memory).toMatchObject({ added: 2, errors: 2 });
    expect(report.doc.errors).toBe(1);
    expect(report.skill.errors).toBe(1);
    expect((await tenant(f, (tx) => tx.select().from(docs)))[0]?.title).toBe("Giữ lại");
    expect(JSON.stringify(report)).not.toContain("invalid-json");
    expect(await tenant(f, (tx) => tx.select().from(legacyDocAssets))).toHaveLength(0);
  });

  it("tài liệu cấp hệ thống vào đội sở hữu; mục đã xoá được bỏ qua cùng lịch sử", async () => {
    const f = await setup();
    editSource(f, (db) => {
      db.exec("UPDATE docs SET removed_at='2024-03-01' WHERE key='org/skills/sample-skill';");
      db.prepare("INSERT INTO docs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
        "system/hoa-don/guide",
        "system",
        "sys:hoa-don",
        "Tài liệu hệ thống",
        "# Tổng hợp",
        1,
        "unknown-agent",
        updatedAt,
        0,
        null,
        "[]",
        null,
      );
      db.prepare("INSERT INTO doc_versions VALUES (?,?,?,?,?,?)").run(
        "system/hoa-don/guide",
        1,
        "# Tổng hợp",
        "unknown-agent",
        "",
        createdAt,
      );
    });
    const report = await importLegacy(app, options(f));
    expect(report.skill.skipped).toBe(1);
    expect(report.skillVersion.skipped).toBe(2);
    expect(report.doc.added).toBe(2);
    const systemDoc = (await tenant(f, (tx) => tx.select().from(docs))).find((d) => d.key.includes("legacy-system"));
    expect(systemDoc).toMatchObject({
      key: "team/thanh-toan/legacy-system/hoa-don/guide",
      teamId: f.teamId,
      projectId: null,
    });
  });

  it("enqueue trong transaction và tính lại vector bằng pipeline mới, không chép vector SQLite", async () => {
    const f = await setup();
    const jobsSeen: Array<{ orgId: string; memoryId: string }> = [];
    const jobs = {
      enqueue: async (queue: string, data: { orgId: string; memoryId: string }, opts: { tx: unknown }) => {
        expect(queue).toBe("knowledge-embed");
        expect(opts.tx).toBeDefined();
        jobsSeen.push(data);
        return "fixture-job";
      },
    } as unknown as Jobs;
    const embedder = { model: "new-fixture-model", embed: async () => [[1, 0, 0]] };
    const vectors = (
      await admin.query(
        "select exists(select 1 from pg_attribute where attrelid='hive.memories'::regclass and attname='embedding') ok",
      )
    ).rows[0].ok;
    await importLegacy(app, options(f), { jobs, embedder });
    expect(jobsSeen).toHaveLength(vectors ? 4 : 0);
    if (vectors) {
      const job = jobsSeen[0];
      expect(job).toBeDefined();
      if (!job) throw new Error("Thiếu job fixture");
      expect(await runEmbed({ pool: app, embedder }, job)).toBe("embedded");
      expect(
        await tenant(f, (tx) =>
          tx.execute(
            sql`select embedding::text as vector, embedding_model as model from hive.memories where id=${job.memoryId}`,
          ),
        ),
      ).toMatchObject({ rows: [{ vector: "[1,0,0]", model: embedder.model }] });
    }
    jobsSeen.length = 0;
    await importLegacy(app, options(f), { jobs, embedder });
    expect(jobsSeen).toHaveLength(0);
  });

  it("hai import đồng thời được tuần tự hoá; URL không phải hive_app bị từ chối", async () => {
    const f = await setup();
    const reports = await Promise.all([importLegacy(app, options(f)), importLegacy(app, options(f))]);
    expect(reports.map((r) => r.memory.added).sort()).toEqual([0, 4]);
    expect(await tenant(f, (tx) => tx.select().from(memories))).toHaveLength(5);
    await expect(importLegacy(admin, options(f))).rejects.toThrow("hive_app");
    await expect(importLegacy(app, { ...options(f), org: "nonexistent-import-org" })).rejects.toThrow(
      "Không tìm thấy tổ chức",
    );
  });
});
