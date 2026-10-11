// Lệnh quản trị database: `node src/cli.ts db:bootstrap` (cần superuser) và `node src/cli.ts db:migrate`.
import { bootstrapRoles, runMigrations } from "./modules/platform/index.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Thiếu biến môi trường ${name}.`);
    process.exit(2);
  }
  return v;
}

const command = process.argv[2];
if (command === "db:bootstrap") {
  await bootstrapRoles(need("HIVE_DATABASE_ADMIN_URL"), {
    owner: need("HIVE_DB_OWNER_PASSWORD"),
    app: need("HIVE_DB_APP_PASSWORD"),
    auth: need("HIVE_DB_AUTH_PASSWORD"),
  });
  console.log("Đã tạo role hive_owner, hive_app, hive_auth và schema hive.");
} else if (command === "db:migrate") {
  await runMigrations(need("HIVE_DATABASE_OWNER_URL"));
  console.log("Đã chạy migration.");
} else {
  console.error("Cách dùng: node src/cli.ts <db:bootstrap|db:migrate>");
  process.exit(2);
}
