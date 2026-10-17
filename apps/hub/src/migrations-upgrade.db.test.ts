import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";
import { seedUsers } from "../test/seed.ts";
import { bootstrapRoles, runMigrations } from "./modules/platform/index.ts";

/**
 * Database test luôn trống: kiểu enum được tạo trong cùng transaction với mọi migration nên dùng ngay giá trị mới được.
 * Máy chủ thật nâng cấp từ database đã có kiểu đó, và Postgres cấm dùng giá trị enum chưa commit (55P04): hub từng
 * không khởi động được sau deploy vì vậy. Test dựng database dừng ngay trước mỗi migration có `ADD VALUE` rồi nâng cấp.
 */
const MIGRATIONS = fileURLToPath(new URL("../db/migrations", import.meta.url));
// Mỗi ca dựng lại toàn bộ lịch sử migration; Docker dùng chung giữa các worktree có thể vượt hai phút.
const UPGRADE_TIMEOUT = 240_000;
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
    it(
      `dừng trước ${entry.tag} rồi nâng cấp lên bản mới nhất trong một lượt`,
      async () => {
        const ownerUrl = await emptyDatabase();
        await runMigrations(ownerUrl, prefixFolder(entry.idx));
        await expect(runMigrations(ownerUrl)).resolves.toBeUndefined();
      },
      UPGRADE_TIMEOUT,
    );
  }

  it(
    "nâng từ trước migration review code: quy trình tài liệu cũ thành subject = doc",
    async () => {
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
    },
    UPGRADE_TIMEOUT,
  );

  it(
    "nâng từ trước migration AI SDLC: task và run cũ có checklist, nhãn rỗng; dùng được vai trò ba và run sdlc",
    async () => {
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
    },
    UPGRADE_TIMEOUT,
  );
  it(
    "nâng từ trước migration artifacts: tin nhắn leader cũ giữ nguyên, bảng và hàm artifacts có đủ",
    async () => {
      const tag = "0069_artifacts";
      const entry = journal.entries.find((e) => e.tag === tag);
      expect(entry).toBeDefined();
      const ownerUrl = await emptyDatabase();
      await runMigrations(ownerUrl, prefixFolder(entry?.idx ?? 0));
      const adminOnDb = new URL(db.adminUrl);
      adminOnDb.pathname = new URL(ownerUrl).pathname;
      const old = new pg.Pool({ connectionString: adminOnDb.toString(), max: 1 });
      try {
        const org = randomUUID();
        await old.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'o', 'u')", [
          org,
          `org-${org.slice(0, 8)}`,
        ]);
        const thread = (
          await old.query(
            "insert into hive.chat_threads (org_id, created_by, title) values ($1, 'u', 't') returning id",
            [org],
          )
        ).rows[0].id;
        await old.query(
          "insert into hive.chat_messages (org_id, thread_id, role, content) values ($1, $2, 'user', 'tin cũ')",
          [org, thread],
        );
        await runMigrations(ownerUrl);
        const { rows } = await old.query(
          "select content, artifact_id, artifact_version, page_errors from hive.chat_messages where org_id = $1",
          [org],
        );
        expect(rows).toEqual([{ content: "tin cũ", artifact_id: null, artifact_version: null, page_errors: null }]);
        const objects = await old.query(
          `select to_regclass('hive.artifacts') as a, to_regclass('hive.artifact_public_links') as l,
                to_regprocedure('hive.artifact_tombstone(uuid)') as t,
                to_regprocedure('hive.artifact_public_link_resolve(text)') as r,
                to_regprocedure('hive.artifact_purge(integer, integer)') as p`,
        );
        expect(objects.rows[0]).toEqual({
          a: "hive.artifacts",
          l: "hive.artifact_public_links",
          t: "hive.artifact_tombstone(uuid)",
          r: "hive.artifact_public_link_resolve(text)",
          p: "hive.artifact_purge(integer,integer)",
        });
      } finally {
        await old.end();
      }
    },
    UPGRADE_TIMEOUT,
  );

  it(
    "nâng từ trước migration thành viên dự án: người tạo còn trong đội thành thành viên, ở mọi tổ chức (FR-040)",
    async () => {
      const tag = "0078_fresh_rattler";
      const entry = journal.entries.find((e) => e.tag === tag);
      expect(entry).toBeDefined();
      const ownerUrl = await emptyDatabase();
      await runMigrations(ownerUrl, prefixFolder(entry?.idx ?? 0));
      const adminOnDb = new URL(db.adminUrl);
      adminOnDb.pathname = new URL(ownerUrl).pathname;
      const old = new pg.Pool({ connectionString: adminOnDb.toString(), max: 1 });
      try {
        const one = async (q: string, p: unknown[]) => (await old.query(q, p)).rows[0].id as string;
        await seedUsers(old, ["stays", "left", "elsewhere", "b-stays"]);
        const org = async () => {
          const id = randomUUID();
          await old.query("insert into hive.orgs (id, slug, name, created_by) values ($1, $2, 'o', 'u')", [
            id,
            `org-${id.slice(0, 8)}`,
          ]);
          return id;
        };
        const orgA = await org();
        const orgB = await org();
        const team = (orgId: string, slug: string) =>
          one("insert into hive.teams (org_id, slug, name) values ($1, $2, $2) returning id", [orgId, slug]);
        const teamA = await team(orgA, "a");
        const teamA2 = await team(orgA, "a2");
        const teamB = await team(orgB, "b");
        // "left" không còn ở đội nào; "elsewhere" chỉ ở đội khác với đội sở hữu dự án mình tạo.
        for (const [orgId, teamId, userId] of [
          [orgA, teamA, "stays"],
          [orgA, teamA2, "elsewhere"],
          [orgB, teamB, "b-stays"],
        ]) {
          await old.query(
            "insert into hive.team_members (team_id, org_id, user_id, role) values ($1, $2, $3, 'member')",
            [teamId, orgId, userId],
          );
        }
        // Bỏ khoá ngoại tới systems và scm_connections: backfill chỉ đọc đội và người tạo của dự án.
        await old.query("set session_replication_role = replica");
        for (const [orgId, teamId, key, createdBy] of [
          [orgA, teamA, "a-stays-1", "stays"],
          [orgA, teamA, "a-stays-2", "stays"],
          [orgA, teamA, "a-left", "left"],
          [orgA, teamA, "a-elsewhere", "elsewhere"],
          [orgB, teamB, "b-stays", "b-stays"],
        ]) {
          await old.query(
            `insert into hive.projects (org_id, team_id, system_id, key, name, scm_connection_id, scm_kind, repo_mode,
               repo_owner, repo_name, settings, idempotency_key, created_by)
             values ($1, $2, $3, $4, $4, $5, 'github', 'existing', 'xdev-team', $4, '{}', $6, $7)`,
            [orgId, teamId, randomUUID(), key, randomUUID(), randomUUID(), createdBy],
          );
        }
        await old.query("set session_replication_role = origin");

        // hive_owner chạy migration và cũng chịu FORCE RLS: thiếu bước NO FORCE thì backfill không thấy dòng nào.
        await runMigrations(ownerUrl);

        const { rows } = await old.query(
          `select p.key, m.org_id, m.team_id, m.user_id, m.added_by
             from hive.project_members m join hive.projects p on p.id = m.project_id
            order by p.key`,
        );
        expect(rows).toEqual([
          { key: "a-stays-1", org_id: orgA, team_id: teamA, user_id: "stays", added_by: "stays" },
          { key: "a-stays-2", org_id: orgA, team_id: teamA, user_id: "stays", added_by: "stays" },
          { key: "b-stays", org_id: orgB, team_id: teamB, user_id: "b-stays", added_by: "b-stays" },
        ]);
        const forced = await old.query(
          `select relname, relforcerowsecurity as forced from pg_class
            where oid in ('hive.projects'::regclass, 'hive.team_members'::regclass, 'hive.project_members'::regclass)
            order by relname`,
        );
        expect(forced.rows).toEqual([
          { relname: "project_members", forced: true },
          { relname: "projects", forced: true },
          { relname: "team_members", forced: true },
        ]);
      } finally {
        await old.end();
      }
    },
    UPGRADE_TIMEOUT,
  );
});
