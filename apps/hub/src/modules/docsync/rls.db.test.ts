import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { pgCode, seedOrg } from "../../../test/org-fixture.ts";
import { bootstrapRoles, createJobs, createPool, runMigrations, type Tx, withTenant } from "../platform/index.ts";
import { DOCSYNC_PUSH_QUEUE, docSyncQueues, queuePull, queuePush } from "./jobs.ts";
import { wordImportBlobRefs } from "./word/blob-refs.ts";

const db = inject("db");
const admin = new pg.Pool({ connectionString: db.adminUrl });
const app = createPool(db.appUrl);
const owner = createPool(db.ownerUrl);
const tableNames = [
  "doc_homes",
  "doc_repo_files",
  "doc_sync_batches",
  "doc_conflicts",
  "doc_imports",
  "doc_import_files",
  "doc_assets",
  "doc_extracts",
  "doc_chunks",
  "blobs",
  "blob_chunks",
  "doc_word_imports",
  "doc_word_import_files",
] as const;
type Table = (typeof tableNames)[number];
type Row = Record<string, string | number | boolean | Buffer | null>;
type Seed = {
  orgId: string;
  userId: string;
  connectionId: string;
  docId: string;
  image: string;
  rows: Record<Table, Row>;
};
const seeds: Record<"a" | "b", Seed> = {} as never;
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const tableSql = (name: Table) => sql`${sql.identifier("hive")}.${sql.identifier(name)}`;

async function insert(tx: Tx, table: Table, values: Row) {
  return tx.execute(
    sql`insert into ${tableSql(table)} (${sql.join(
      Object.keys(values).map((key) => sql.identifier(key)),
      sql`, `,
    )}) values (${sql.join(
      Object.values(values).map((value) => sql`${value}`),
      sql`, `,
    )})`,
  );
}
const asA = <T>(run: (tx: Tx) => Promise<T>) => withTenant(app, { orgId: seeds.a.orgId, userId: seeds.a.userId }, run);

async function seed(name: string): Promise<Seed> {
  const org = await seedOrg(admin, `docsync-${name}-${randomUUID().slice(0, 8)}`);
  const orgId = org.orgId;
  const userId = org.user("owner");
  const connectionId = randomUUID();
  const docId = randomUUID();
  await admin.query(
    "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'github', 'docs', 'fixture', $3)",
    [connectionId, orgId, userId],
  );
  await admin.query(
    "insert into hive.docs (id, org_id, key, title, current_version, updated_by_user_id) values ($1, $2, 'org/guide', 'Hướng dẫn', 1, $3)",
    [docId, orgId, userId],
  );
  const home = randomUUID(),
    blob = randomUUID(),
    asset = randomUUID(),
    extract = randomUUID(),
    importing = randomUUID(),
    wordImport = randomUUID(),
    // Ảnh của lượt nhập chỉ nằm trong jsonb, không có khoá ngoại tới blobs.
    image = randomUUID();
  const row = (values: Row): Row => ({ id: randomUUID(), org_id: orgId, ...values });
  const rows: Record<Table, Row> = {
    doc_homes: row({
      id: home,
      scope: "org",
      connection_id: connectionId,
      owner: "org",
      name: "docs",
      branch: "main",
      configured_by: userId,
    }),
    doc_repo_files: row({ home_id: home, doc_id: docId, repo_path: "docs/guide.md" }),
    doc_sync_batches: row({ home_id: home, mode: "pr", branch: "hive/docs-sync" }),
    doc_conflicts: row({
      home_id: home,
      doc_id: docId,
      base_version: 1,
      hub_version: 2,
      repo_commit: "abc",
      repo_content: "Bản repo",
    }),
    doc_imports: row({ id: importing, home_id: home, started_by: userId }),
    blobs: row({ id: blob, sha256: sha256("ảnh"), size: 3, media_type: "image/png", chunk_count: 1 }),
    blob_chunks: { org_id: orgId, blob_id: blob, ord: 0, data: Buffer.from([1, 2, 3]) },
    doc_assets: row({
      id: asset,
      home_id: home,
      repo_path: "docs/assets/a.png",
      blob_id: blob,
      media_type: "image/png",
      size: 3,
      sha256: sha256("ảnh"),
      owner_doc_id: docId,
    }),
    doc_extracts: row({ id: extract, asset_id: asset, source_sha256: sha256("ảnh"), content: "Tài liệu tiếng Việt" }),
    doc_import_files: row({
      import_id: importing,
      repo_path: "docs/guide.md",
      kind: "markdown",
      doc_id: docId,
      asset_id: asset,
    }),
    doc_chunks: row({ doc_id: docId, version: 1, ord: 0, content: "Hướng dẫn cài đặt" }),
    doc_word_imports: row({ id: wordImport, home_id: home, target_dir: "docs/srs/", created_by: userId }),
    doc_word_import_files: row({
      import_id: wordImport,
      relative_dir: "OPD",
      file_name: "OPD17_v1.1.docx",
      format: "docx",
      size: 3,
      sha256: sha256("word"),
      blob_id: blob,
      images: JSON.stringify([{ name: "9527ba12e6da.png", blobId: image, mediaType: "image/png", bytes: 3 }]),
    }),
  };
  await withTenant(app, { orgId, userId }, async (tx) => {
    for (const table of [
      "doc_homes",
      "doc_repo_files",
      "doc_sync_batches",
      "doc_conflicts",
      "doc_imports",
      "blobs",
      "blob_chunks",
      "doc_assets",
      "doc_extracts",
      "doc_import_files",
      "doc_chunks",
      "doc_word_imports",
      "doc_word_import_files",
    ] as const)
      await insert(tx, table, rows[table]);
  });
  return { orgId, userId, connectionId, docId, image, rows };
}

beforeAll(async () => {
  seeds.a = await seed("a");
  seeds.b = await seed("b");
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), owner.end()]);
});

describe("RLS các bảng nền docsync", () => {
  it("bật và ép RLS, policy có USING/WITH CHECK, hive_app không có TRUNCATE", async () => {
    const { rows } = await admin.query(
      "select relname, relrowsecurity, relforcerowsecurity, has_table_privilege('hive_app', oid, 'TRUNCATE') as truncate from pg_class where oid = any($1::regclass[])",
      [tableNames.map((name) => `hive.${name}`)],
    );
    expect(rows).toHaveLength(tableNames.length);
    for (const row of rows)
      expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, truncate: false });
    const policies = await admin.query(
      "select tablename, policyname, roles::text[] as roles, qual, with_check from pg_policies where schemaname = 'hive' and tablename = any($1)",
      [tableNames],
    );
    // doc_homes có thêm policy SELECT cho webhook (tra nhà theo id khi chưa biết tổ chức) và cho hive_owner
    // (hive.docsync_active_orgs chạy SECURITY DEFINER để cron kéo repo tìm tổ chức).
    expect(policies.rows).toHaveLength(tableNames.length + 2);
    expect(policies.rows.find((row) => row.policyname === "doc_homes_owner_select")).toMatchObject({
      roles: ["hive_owner"],
      qual: "true",
      with_check: null,
    });
    const extra = new Set(["doc_homes_webhook", "doc_homes_owner_select"]);
    for (const policy of policies.rows.filter((row) => !extra.has(row.policyname))) {
      expect(policy.policyname).toBe(`${policy.tablename}_rw`);
      expect(policy.roles).toEqual(["hive_app"]);
      expect(policy.qual).toContain("ctx_org()");
      expect(policy.with_check).toContain("ctx_org()");
    }
  });

  it("không tenant: hive_app và chủ bảng đều không thấy dữ liệu", async () => {
    for (const pool of [app, owner])
      await withTenant(pool, {}, async (tx) => {
        for (const table of tableNames) {
          // Chủ bảng chỉ đọc được doc_homes, cho hàm SECURITY DEFINER docsync_active_orgs.
          if (pool === owner && table === "doc_homes") continue;
          expect((await tx.execute(sql`select * from ${tableSql(table)}`)).rows).toEqual([]);
        }
      });
  });

  it("hive.docsync_active_orgs chỉ trả tổ chức có nhà đang chạy, chủ bảng không sửa được doc_homes", async () => {
    const active = () =>
      withTenant(app, {}, async (tx) =>
        (await tx.execute<{ org_id: string }>(sql`select org_id from hive.docsync_active_orgs()`)).rows.map(
          (r) => r.org_id,
        ),
      );
    expect(await active()).toEqual(expect.arrayContaining([seeds.a.orgId, seeds.b.orgId]));
    await admin.query("update hive.doc_homes set status = 'paused' where org_id = $1", [seeds.b.orgId]);
    try {
      expect(await active()).not.toContain(seeds.b.orgId);
    } finally {
      await admin.query("update hive.doc_homes set status = 'active' where org_id = $1", [seeds.b.orgId]);
    }
    await withTenant(owner, {}, async (tx) =>
      expect((await tx.execute(sql`update hive.doc_homes set mode = 'off' returning id`)).rows).toEqual([]),
    );
  });

  for (const table of tableNames) {
    it(`${table}: đọc đúng tenant, chặn INSERT/UPDATE chéo và không sửa/xoá dòng tenant khác`, async () => {
      await asA(async (tx) => {
        expect((await tx.execute(sql`select current_user as role`)).rows[0]).toEqual({ role: "hive_app" });
        const rows = (await tx.execute(sql`select * from ${tableSql(table)}`)).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.org_id).toBe(seeds.a.orgId);
        expect(
          (
            await tx.execute(
              sql`update ${tableSql(table)} set org_id = ${seeds.b.orgId} where org_id = ${seeds.b.orgId} returning *`,
            )
          ).rows,
        ).toEqual([]);
        expect(
          (await tx.execute(sql`delete from ${tableSql(table)} where org_id = ${seeds.b.orgId} returning *`)).rows,
        ).toEqual([]);
      });
      expect(
        await pgCode(() => asA((tx) => insert(tx, table, { ...seeds.a.rows[table], org_id: seeds.b.orgId }))),
      ).toBe("42501");
      expect(
        await pgCode(() => asA((tx) => tx.execute(sql`update ${tableSql(table)} set org_id = ${seeds.b.orgId}`))),
      ).toBe("42501");
    });
  }

  it("khóa ngoại kép chặn tham chiếu sang tenant khác", async () => {
    const cases: Array<[Table, Row]> = [
      ["doc_homes", { connection_id: seeds.b.connectionId }],
      ["doc_repo_files", { home_id: String(seeds.b.rows.doc_homes.id), repo_path: "other.md", doc_id: randomUUID() }],
      ["doc_sync_batches", { home_id: String(seeds.b.rows.doc_homes.id) }],
      ["doc_conflicts", { doc_id: seeds.b.docId }],
      ["doc_imports", { home_id: String(seeds.b.rows.doc_homes.id) }],
      ["doc_import_files", { import_id: String(seeds.b.rows.doc_imports.id), repo_path: "other.md" }],
      ["doc_assets", { blob_id: String(seeds.b.rows.blobs.id), repo_path: "other.png" }],
      ["doc_extracts", { asset_id: String(seeds.b.rows.doc_assets.id) }],
      ["doc_chunks", { doc_id: seeds.b.docId }],
      ["blob_chunks", { blob_id: String(seeds.b.rows.blobs.id), ord: 1 }],
      ["doc_word_imports", { home_id: String(seeds.b.rows.doc_homes.id) }],
      ["doc_word_import_files", { import_id: String(seeds.b.rows.doc_word_imports.id), file_name: "other.docx" }],
    ];
    for (const [table, changes] of cases) {
      const row = { ...seeds.a.rows[table], ...changes };
      if ("id" in row) row.id = randomUUID();
      // Tránh đụng unique trước khi Postgres kiểm khóa ngoại.
      if (table === "doc_homes") {
        row.scope = "project";
        row.project_id = randomUUID();
      }
      if (table === "doc_conflicts") row.state = "resolved";
      if (table === "doc_chunks") row.ord = 9;
      expect(await pgCode(() => asA((tx) => insert(tx, table, row))), table).toBe("23503");
    }
  });

  it("chỉ một nhà tổ chức, file theo đường dẫn, blob theo hash và xung đột mở", async () => {
    for (const table of [
      "doc_homes",
      "doc_repo_files",
      "doc_import_files",
      "blobs",
      "doc_conflicts",
      "doc_word_import_files",
    ] as const) {
      expect(
        await pgCode(() => asA((tx) => insert(tx, table, { ...seeds.a.rows[table], id: randomUUID() }))),
        table,
      ).toBe("23505");
    }
    await asA((tx) =>
      insert(tx, "doc_conflicts", {
        ...seeds.a.rows.doc_conflicts,
        id: randomUUID(),
        state: "resolved",
        resolution: "repo",
      }),
    );
    await asA((tx) =>
      insert(tx, "doc_extracts", { ...seeds.a.rows.doc_extracts, id: randomUUID(), state: "approved" }),
    );
    expect(
      await pgCode(() =>
        asA((tx) => insert(tx, "doc_extracts", { ...seeds.a.rows.doc_extracts, id: randomUUID(), state: "approved" })),
      ),
    ).toBe("23505");
  });

  it("nhập Word: lượt tạo cần thư mục đích, cập nhật cần tài liệu; trạng thái và định dạng theo hợp đồng", async () => {
    const wordImport = seeds.a.rows.doc_word_imports;
    const file = seeds.a.rows.doc_word_import_files;
    const bad: Array<[Table, Row]> = [
      ["doc_word_imports", { ...wordImport, target_dir: null }],
      ["doc_word_imports", { ...wordImport, mode: "update" }],
      ["doc_word_imports", { ...wordImport, mode: "merge" }],
      ["doc_word_imports", { ...wordImport, state: "queued" }],
      ["doc_word_import_files", { ...file, file_name: "a.pdf", format: "pdf" }],
      ["doc_word_import_files", { ...file, file_name: "b.docx", state: "uploading" }],
      ["doc_word_import_files", { ...file, file_name: "c.docx", size: -1 }],
      ["doc_word_import_files", { ...file, file_name: "d.docx", doc_version: 0 }],
    ];
    for (const [table, row] of bad)
      expect(
        await pgCode(() => asA((tx) => insert(tx, table, { ...row, id: randomUUID() }))),
        JSON.stringify(row),
      ).toBe("23514");
    await asA(async (tx) => {
      await insert(tx, "doc_word_imports", {
        ...wordImport,
        id: randomUUID(),
        mode: "link",
        target_dir: null,
        update_doc_id: seeds.a.docId,
      });
      // Cùng tên file ở thư mục con khác là hai file khác nhau của lượt.
      await insert(tx, "doc_word_import_files", { ...file, id: randomUUID(), relative_dir: "IPD" });
      const [created] = (
        await tx.execute(
          sql`select i.mode, i.state as import_state, i.confidential, i.counts, f.state, f.keep_front, f.excluded, f.warnings, f.findings from hive.doc_word_imports i join hive.doc_word_import_files f on f.import_id = i.id where f.id = ${file.id}`,
        )
      ).rows;
      expect(created).toMatchObject({
        mode: "create",
        import_state: "uploading",
        counts: { queued: 0, ready: 0, blockedSecret: 0, done: 0 },
        state: "queued",
        confidential: false,
        keep_front: false,
        excluded: false,
        warnings: [],
        findings: [],
      });
    });
  });

  it("xung đột nguồn Word không có commit nhưng phải có gốc; xung đột repo vẫn cần commit", async () => {
    const conflict: Row = { ...seeds.a.rows.doc_conflicts, state: "resolved", resolution: "hub" };
    const [old] = (
      await asA((tx) =>
        tx.execute(
          sql`select origin, base_content from hive.doc_conflicts where id = ${seeds.a.rows.doc_conflicts.id}`,
        ),
      )
    ).rows;
    expect(old).toEqual({ origin: "repo", base_content: null });
    for (const changes of [
      { repo_commit: null },
      { origin: "word", repo_commit: null },
      { origin: "mail", repo_commit: null, base_content: "gốc" },
    ])
      expect(
        await pgCode(() => asA((tx) => insert(tx, "doc_conflicts", { ...conflict, id: randomUUID(), ...changes }))),
        JSON.stringify(changes),
      ).toBe("23514");
    await asA((tx) =>
      insert(tx, "doc_conflicts", {
        ...conflict,
        id: randomUUID(),
        origin: "word",
        repo_commit: null,
        repo_content: "Bản Word",
        base_content: "Bản nhập lần trước",
      }),
    );
  });

  it("đính kèm nhận pending_delete; nhà mặc định không bật tài liệu mật khi nhập Word", async () => {
    await asA(async (tx) => {
      await insert(tx, "doc_assets", {
        ...seeds.a.rows.doc_assets,
        id: randomUUID(),
        repo_path: "docs/assets/old.png",
        state: "pending_delete",
      });
      const [home] = (
        await tx.execute(
          sql`select word_import_confidential from hive.doc_homes where id = ${seeds.a.rows.doc_homes.id}`,
        )
      ).rows;
      expect(home).toEqual({ word_import_confidential: false });
    });
  });

  it("GC thấy file gốc và ảnh của lượt nhập Word, chỉ trong tenant", async () => {
    const blob = String(seeds.a.rows.blobs.id);
    const other = randomUUID();
    expect(await asA((tx) => wordImportBlobRefs(tx, [blob, seeds.a.image, other]))).toEqual(
      new Set([blob, seeds.a.image]),
    );
    expect(await asA((tx) => wordImportBlobRefs(tx, []))).toEqual(new Set());
    expect(await asA((tx) => wordImportBlobRefs(tx, [String(seeds.b.rows.blobs.id), seeds.b.image]))).toEqual(
      new Set(),
    );
  });

  it("doc_chunks có đúng một nguồn, tsvector GIN; bytea giữ nguyên dữ liệu", async () => {
    const chunk = seeds.a.rows.doc_chunks;
    for (const changes of [{ doc_id: null }, { extract_id: String(seeds.a.rows.doc_extracts.id) }]) {
      expect(
        await pgCode(() => asA((tx) => insert(tx, "doc_chunks", { ...chunk, id: randomUUID(), ord: 10, ...changes }))),
      ).toBe("23514");
    }
    await asA(async (tx) => {
      const rows = await tx.execute(
        sql`select content from hive.doc_chunks where search @@ plainto_tsquery('simple', 'Hướng dẫn')`,
      );
      expect(rows.rows).toHaveLength(1);
      expect((await tx.execute(sql`select data from hive.blob_chunks`)).rows[0]?.data).toEqual(Buffer.from([1, 2, 3]));
    });
    const index = await admin.query(
      "select indexdef from pg_indexes where schemaname = 'hive' and indexname = 'doc_chunks_search'",
    );
    expect(index.rows[0].indexdef).toContain("USING gin (search)");
  });

  it("pg-boss thật gom từng nhà, chờ đủ hạn và rollback cùng dữ liệu", async () => {
    const jobs = createJobs({ connectionString: db.jobsUrl, queues: docSyncQueues, maintenance: false });
    await jobs.start();
    try {
      const data = { orgId: seeds.a.orgId, homeId: String(seeds.a.rows.doc_homes.id) };
      const first = await asA((tx) => queuePush(jobs, data, { tx }));
      expect(first).toBeTypeOf("string");
      expect(await asA((tx) => queuePush(jobs, data, { tx }))).toBeNull();
      expect(await queuePull(jobs, data)).toBeTypeOf("string");
      expect(await queuePush(jobs, { ...data, homeId: String(String(seeds.b.rows.doc_homes.id)) })).toBeTypeOf(
        "string",
      );
      const pending = await admin.query(
        "select data, singleton_key, extract(epoch from (start_after - created_on)) as delay from pgboss.job where id = $1",
        [first],
      );
      expect(pending.rows[0]).toMatchObject({ data, singleton_key: data.homeId });
      expect(Number(pending.rows[0].delay)).toBeGreaterThan(58);
      const rolledBack = randomUUID();
      await expect(
        asA(async (tx) => {
          await queuePush(jobs, { ...data, homeId: rolledBack }, { tx });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(
        (
          await admin.query("select id from pgboss.job where name = $1 and singleton_key = $2", [
            DOCSYNC_PUSH_QUEUE,
            rolledBack,
          ])
        ).rows,
      ).toEqual([]);
    } finally {
      await jobs.stop();
    }
  });
});

it("nâng từ 0072: điền hash mọi tenant, giữ LF/CRLF/BOM, hỗ trợ không pgvector rồi bật sau", async () => {
  const name = `docsync_up_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const onDb = (url: string) => {
    const parsed = new URL(url);
    parsed.pathname = `/${name}`;
    return parsed.toString();
  };
  await admin.query(`create database ${name}`);
  const old = new pg.Pool({ connectionString: onDb(db.adminUrl) });
  const upgradedOwner = new pg.Pool({ connectionString: onDb(db.ownerUrl) });
  const migrations = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  const cache = fileURLToPath(new URL("../../../node_modules/.cache", import.meta.url));
  mkdirSync(cache, { recursive: true });
  const prefix = mkdtempSync(join(cache, "docsync-upgrade-"));
  try {
    const password = (url: string) => decodeURIComponent(new URL(url).password);
    await bootstrapRoles(
      onDb(db.adminUrl),
      { owner: password(db.ownerUrl), app: password(db.appUrl), auth: password(db.authUrl) },
      { pgvector: false },
    );
    cpSync(migrations, prefix, { recursive: true });
    const journal = JSON.parse(readFileSync(join(prefix, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { tag: string }) => Number(entry.tag.slice(0, 4)) <= 72);
    expect(journal.entries.at(-1).tag).toMatch(/^0072_/);
    writeFileSync(join(prefix, "meta/_journal.json"), JSON.stringify(journal));
    await runMigrations(onDb(db.ownerUrl), prefix);
    const contents = ["# Tài liệu\n", "# Tài liệu\r\n", "\uFEFF# Tài liệu\r\n"];
    for (const [i, content] of contents.entries()) {
      const org = await seedOrg(old, `old-${i}-${randomUUID().slice(0, 6)}`);
      const doc = (
        await old.query(
          "insert into hive.docs (org_id, key, title, current_version, updated_by_user_id) values ($1, 'org/old', 'Cũ', 1, $2) returning id",
          [org.orgId, org.user("owner")],
        )
      ).rows[0].id;
      await old.query(
        "insert into hive.doc_versions (org_id, doc_id, version, title, content, author_user_id) values ($1, $2, 1, 'Cũ', $3, $4)",
        [org.orgId, doc, content, org.user("owner")],
      );
    }
    await runMigrations(onDb(db.ownerUrl));
    const versions = (
      await old.query("select content, content_hash, source, repo_commit, secret_flag from hive.doc_versions")
    ).rows;
    expect(versions).toHaveLength(contents.length);
    for (const row of versions)
      expect(row).toMatchObject({
        content_hash: sha256(row.content),
        source: "hub",
        repo_commit: null,
        secret_flag: false,
      });
    expect(
      (await old.query("select relforcerowsecurity from pg_class where oid = 'hive.doc_versions'::regclass")).rows[0]
        .relforcerowsecurity,
    ).toBe(true);
    expect((await upgradedOwner.query("select hive.enable_doc_vectors() as enabled")).rows[0].enabled).toBe(false);
    await old.query("create extension if not exists vector");
    for (let i = 0; i < 2; i++)
      expect((await upgradedOwner.query("select hive.enable_doc_vectors() as enabled")).rows[0].enabled).toBe(true);
    expect(
      (await old.query("select has_function_privilege('hive_app', 'hive.enable_doc_vectors()', 'EXECUTE') as allowed"))
        .rows[0].allowed,
    ).toBe(false);
    expect(
      (
        await old.query(
          "select 1 from information_schema.columns where table_schema = 'hive' and table_name = 'doc_chunks' and column_name = 'embedding'",
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
    await Promise.all([old.end(), upgradedOwner.end()]);
    await admin.query(`drop database ${name}`);
  }
}, 240_000);

it("nâng từ trước migration nhập Word: xung đột cũ là nguồn repo, nhà cũ không bật tài liệu mật", async () => {
  const name = `docsync_word_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const onDb = (url: string) => {
    const parsed = new URL(url);
    parsed.pathname = `/${name}`;
    return parsed.toString();
  };
  await admin.query(`create database ${name}`);
  const old = new pg.Pool({ connectionString: onDb(db.adminUrl) });
  const migrations = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
  const cache = fileURLToPath(new URL("../../../node_modules/.cache", import.meta.url));
  mkdirSync(cache, { recursive: true });
  const prefix = mkdtempSync(join(cache, "docsync-word-upgrade-"));
  try {
    const password = (url: string) => decodeURIComponent(new URL(url).password);
    await bootstrapRoles(
      onDb(db.adminUrl),
      { owner: password(db.ownerUrl), app: password(db.appUrl), auth: password(db.authUrl) },
      { pgvector: false },
    );
    cpSync(migrations, prefix, { recursive: true });
    const journal = JSON.parse(readFileSync(join(prefix, "meta/_journal.json"), "utf8"));
    const word = journal.entries.find((entry: { tag: string }) =>
      readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").includes('CREATE TABLE "hive"."doc_word_imports"'),
    );
    expect(word).toBeDefined();
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < word.idx);
    writeFileSync(join(prefix, "meta/_journal.json"), JSON.stringify(journal));
    await runMigrations(onDb(db.ownerUrl), prefix);
    const org = await seedOrg(old, `word-up-${randomUUID().slice(0, 6)}`);
    const [connectionId, homeId, docId] = [randomUUID(), randomUUID(), randomUUID()];
    await old.query(
      "insert into hive.scm_connections (id, org_id, kind, name, secret_enc, created_by) values ($1, $2, 'github', 'docs', 'fixture', $3)",
      [connectionId, org.orgId, org.user("owner")],
    );
    await old.query(
      "insert into hive.doc_homes (id, org_id, scope, connection_id, owner, name, branch, configured_by) values ($1, $2, 'org', $3, 'org', 'docs', 'main', $4)",
      [homeId, org.orgId, connectionId, org.user("owner")],
    );
    await old.query(
      "insert into hive.docs (id, org_id, key, title, current_version, updated_by_user_id) values ($1, $2, 'org/guide', 'Hướng dẫn', 1, $3)",
      [docId, org.orgId, org.user("owner")],
    );
    await old.query(
      "insert into hive.doc_conflicts (org_id, home_id, doc_id, base_version, hub_version, repo_commit, repo_content) values ($1, $2, $3, 1, 2, 'abc', 'Bản repo')",
      [org.orgId, homeId, docId],
    );
    await runMigrations(onDb(db.ownerUrl));
    expect((await old.query("select origin, repo_commit, base_content from hive.doc_conflicts")).rows).toEqual([
      { origin: "repo", repo_commit: "abc", base_content: null },
    ]);
    expect((await old.query("select word_import_confidential from hive.doc_homes")).rows).toEqual([
      { word_import_confidential: false },
    ]);
    const tables = await old.query(
      `select relname, relforcerowsecurity, ${["SELECT", "INSERT", "UPDATE", "DELETE"].map((p) => `has_table_privilege('hive_app', oid, '${p}')`).join(" and ")} as rw, has_table_privilege('hive_app', oid, 'TRUNCATE') as truncate from pg_class where oid = any($1::regclass[]) order by relname`,
      [["hive.doc_word_imports", "hive.doc_word_import_files"]],
    );
    expect(tables.rows).toEqual([
      { relname: "doc_word_import_files", relforcerowsecurity: true, rw: true, truncate: false },
      { relname: "doc_word_imports", relforcerowsecurity: true, rw: true, truncate: false },
    ]);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
    await old.end();
    await admin.query(`drop database ${name}`);
  }
}, 240_000);
