import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { bootstrapRoles, runMigrations } from "./modules/platform/index.ts";

/**
 * Database test luôn trống: kiểu enum được tạo trong cùng transaction với mọi migration nên dùng ngay giá trị mới được.
 * Máy chủ thật nâng cấp từ database đã có kiểu đó, và Postgres cấm dùng giá trị enum chưa commit (55P04): hub từng
 * không khởi động được sau deploy vì vậy. Test dựng database dừng ngay trước mỗi migration có `ADD VALUE` rồi nâng cấp.
 */
const MIGRATIONS = fileURLToPath(new URL("../db/migrations", import.meta.url));
const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};
const addsEnumValue = journal.entries.filter((e) =>
  /ALTER TYPE [^;]+ ADD VALUE/i.test(readFileSync(join(MIGRATIONS, `${e.tag}.sql`), "utf8")),
);

const db = inject("db");
const tmp = mkdtempSync(join(tmpdir(), "hive-migrations-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Bản sao thư mục migration chỉ gồm `count` migration đầu, như một bản hub cũ. */
function prefixFolder(count: number): string {
  const dir = join(tmp, `prefix-${count}`);
  cpSync(MIGRATIONS, dir, { recursive: true });
  const kept = new Set(journal.entries.slice(0, count).map((e) => e.tag));
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".sql") && !kept.has(file.slice(0, -4))) rmSync(join(dir, file));
  }
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }),
  );
  return dir;
}

async function emptyDatabase() {
  const name = `hive_up_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: db.adminUrl, max: 1 });
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const on = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const pw = (url: string) => decodeURIComponent(new URL(url).password);
  await bootstrapRoles(on(db.adminUrl), { owner: pw(db.ownerUrl), app: pw(db.appUrl), auth: pw(db.authUrl) });
  return on(db.ownerUrl);
}

describe("nâng cấp database đã có dữ liệu", () => {
  it("có migration thêm giá trị enum để kiểm", () => {
    expect(addsEnumValue.length).toBeGreaterThan(0);
  });

  for (const entry of addsEnumValue) {
    it(`dừng trước ${entry.tag} rồi nâng cấp lên bản mới nhất trong một lượt`, async () => {
      const ownerUrl = await emptyDatabase();
      await runMigrations(ownerUrl, prefixFolder(entry.idx));
      await expect(runMigrations(ownerUrl)).resolves.toBeUndefined();
    });
  }

  it("nâng từ trước migration review code: quy trình tài liệu cũ thành subject = doc", async () => {
    const tag = "0056_code_review_workflows";
    const entry = journal.entries.find((e) => e.tag === tag);
    expect(entry).toBeDefined();
    const ownerUrl = await emptyDatabase();
    await runMigrations(ownerUrl, prefixFolder(entry?.idx ?? 0));
    // Superuser vì hive_owner cũng chịu RLS (FORCE) nên không tự seed được dòng của tổ chức.
    const adminOnDb = new URL(db.adminUrl);
    adminOnDb.pathname = new URL(ownerUrl).pathname;
    const old = new pg.Pool({ connectionString: adminOnDb.toString(), max: 1 });
    try {
      const org = randomUUID();
      await old.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'o', 'u')", [
        org,
        `org-${org.slice(0, 8)}`,
      ]);
      await old.query(
        "insert into hive.review_workflows (org_id, name, preset, doc_prefixes, phases) values ($1, 'cũ', 'aidlc', '{specs/}', '[]')",
        [org],
      );
      await runMigrations(ownerUrl);
      const { rows } = await old.query("select subject, code from hive.review_workflows where org_id = $1", [org]);
      expect(rows).toEqual([{ subject: "doc", code: null }]);
      const tables = await old.query(
        "select to_regclass('hive.code_reviews') as r, to_regclass('hive.code_review_gate_runs') as g",
      );
      expect(tables.rows[0]).toEqual({ r: "hive.code_reviews", g: "hive.code_review_gate_runs" });
    } finally {
      await old.end();
    }
  });

  it("nâng từ trước migration AI SDLC: task và run cũ có checklist, nhãn rỗng; dùng được vai trò ba và run sdlc", async () => {
    const tag = "0068_ai_sdlc";
    const entry = journal.entries.find((e) => e.tag === tag);
    expect(entry).toBeDefined();
    const ownerUrl = await emptyDatabase();
    await runMigrations(ownerUrl, prefixFolder(entry?.idx ?? 0));
    const adminOnDb = new URL(db.adminUrl);
    adminOnDb.pathname = new URL(ownerUrl).pathname;
    const old = new pg.Pool({ connectionString: adminOnDb.toString(), max: 1 });
    try {
      const org = randomUUID();
      const one = async (q: string, p: unknown[]) => (await old.query(q, p)).rows[0].id as string;
      await old.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'o', 'u')", [
        org,
        `org-${org.slice(0, 8)}`,
      ]);
      const team = await one("insert into hive.teams (org_id, slug, name) values ($1, 't', 't') returning id", [org]);
      // Bỏ khoá ngoại tới projects: dựng dự án đủ cột chỉ để thử cột mới của tasks và runs thì quá dài.
      await old.query("set session_replication_role = replica");
      const project = randomUUID();
      const task = await one(
        `insert into hive.tasks (org_id, team_id, project_id, number, key, title, created_by)
         values ($1, $2, $3, 1, 'k-1', 't', 'u') returning id`,
        [org, team, project],
      );
      const run = await one(
        `insert into hive.runs (org_id, team_id, task_id, project_id, branch, policy_snapshot, created_by)
         values ($1, $2, $3, $4, 'ai/k-1', '[]', 'u') returning id`,
        [org, team, task, project],
      );
      await old.query("set session_replication_role = origin");

      await runMigrations(ownerUrl);

      const t = await old.query("select checklist from hive.tasks where id = $1", [task]);
      expect(t.rows).toEqual([{ checklist: [] }]);
      const r = await old.query("select required_labels from hive.runs where id = $1", [run]);
      expect(r.rows).toEqual([{ required_labels: [] }]);
      expect((await old.query("select 'ba'::hive.team_role as r")).rows).toEqual([{ r: "ba" }]);
      await old.query("update hive.runs set kind = 'sdlc' where id = $1", [run]);
      const fn = await old.query("select to_regprocedure('hive.sdlc_active_orgs()') as f");
      expect(fn.rows[0].f).toBe("hive.sdlc_active_orgs()");
    } finally {
      await old.end();
    }
  });
});
