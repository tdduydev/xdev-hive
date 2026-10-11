import { randomUUID } from "node:crypto";
import pg from "pg";
import { bootstrapRoles, runMigrations } from "../src/modules/platform/index.ts";

/**
 * Tạo người dùng tối thiểu trong auth."user" cho test seed thẳng bằng superuser: org_members và team_members có
 * khoá ngoại tới bảng này. Các file test chạy song song trên cùng database nên bỏ qua id đã có.
 */
export async function seedUsers(admin: pg.Pool, ids: string[]): Promise<void> {
  await admin.query(
    `insert into auth."user" (id, name, email) select id, id, id || '@seed.test' from unnest($1::text[]) as id
     on conflict (id) do nothing`,
    [ids],
  );
}

/**
 * Database riêng trong cùng container, đã bootstrap và migrate. Dùng cho test cần hub "trống" (quy tắc tạo tổ chức
 * đầu tiên): database chung có tổ chức do file test khác seed song song.
 */
export async function freshDatabase(db: { adminUrl: string; ownerUrl: string; appUrl: string; authUrl: string }) {
  const name = `hive_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
  const urls = { adminUrl: on(db.adminUrl), ownerUrl: on(db.ownerUrl), appUrl: on(db.appUrl), authUrl: on(db.authUrl) };
  await bootstrapRoles(urls.adminUrl, { owner: pw(db.ownerUrl), app: pw(db.appUrl), auth: pw(db.authUrl) });
  await runMigrations(urls.ownerUrl);
  return urls;
}
