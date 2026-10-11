import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const MIGRATIONS = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

export interface RolePasswords {
  owner: string;
  app: string;
  auth: string;
  /** Bỏ trống thì không tạo hive_jobs (hub chạy không có hàng đợi). */
  jobs?: string | undefined;
}

/**
 * Tạo ba role và quyền nền. Chạy bằng tài khoản superuser một lần khi dựng database (và mỗi lần đổi mật khẩu).
 * hive_owner sở hữu schema và chạy migration; hive_app là role của hub, không bao giờ BYPASSRLS;
 * hive_auth dành cho bảng đăng nhập (M1b); hive_jobs chỉ sở hữu schema pgboss của hàng đợi.
 */
export async function bootstrapRoles(adminUrl: string, pw: RolePasswords): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const db = (await client.query<{ db: string }>("select current_database() as db")).rows[0]?.db ?? "";
    const lit = (s: string) => client.escapeLiteral(s);
    const ident = (s: string) => client.escapeIdentifier(s);
    const roles: Array<[string, string]> = [
      ["hive_owner", pw.owner],
      ["hive_app", pw.app],
      ["hive_auth", pw.auth],
    ];
    if (pw.jobs) roles.push(["hive_jobs", pw.jobs]);
    for (const [role, password] of roles) {
      await client.query(
        `do $$ begin if not exists (select from pg_roles where rolname = ${lit(role)}) then create role ${role} login; end if; end $$`,
      );
      await client.query(
        `alter role ${role} login nosuperuser nocreatedb nocreaterole nobypassrls password ${lit(password)}`,
      );
      await client.query(`grant connect on database ${ident(db)} to ${role}`);
    }
    // Better Auth gọi bảng không kèm schema; search_path của hive_auth trỏ vào schema auth.
    await client.query("alter role hive_auth set search_path = auth");
    // Không ai ngoài chủ được tạo bảng trong public; dữ liệu của hub nằm trong schema hive.
    await client.query("revoke create on schema public from public");
    await client.query("create schema if not exists hive authorization hive_owner");
    // Migrator của Drizzle luôn chạy CREATE SCHEMA IF NOT EXISTS, lệnh này cần quyền CREATE trên database.
    await client.query(`grant create on database ${ident(db)} to hive_owner`);
    // pg-boss tự tạo bảng lúc start; cho hive_jobs một schema riêng thay vì quyền CREATE trên cả database.
    if (pw.jobs) await client.query("create schema if not exists pgboss authorization hive_jobs");
  } finally {
    await client.end();
  }
}

/** Chạy migration bằng hive_owner. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await migrate(drizzle(pool), {
      migrationsFolder: MIGRATIONS,
      migrationsSchema: "hive",
      migrationsTable: "migrations",
    });
  } finally {
    await pool.end();
  }
}
