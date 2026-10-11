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
});
