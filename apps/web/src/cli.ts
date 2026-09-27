// Hub admin from the server shell (e.g. when the admin token is lost):
//   npm run token -w @xdev-hive/web -- create <name> [viewer|agent|admin]
//   npm run token -w @xdev-hive/web -- list
//   npm run token -w @xdev-hive/web -- revoke <id>
//   npm run backup -w @xdev-hive/web -- [dir] [keep]   (default HIVE_BACKUP_DIR, else data/backups; keep 7)
import path from "node:path";
import type { Role } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { backupFile } from "./backup.ts";
import { TokenStore } from "./tokens.ts";

const dbPath = path.resolve(process.env.HIVE_DB ?? path.join(import.meta.dirname, "..", "data", "hub.db"));
const [cmd, arg, role] = process.argv.slice(2);

// Backup reads the file as it is: no SqliteHive, so an older database is not migrated first.
if (cmd === "backup") {
  const dir = path.resolve(arg ?? process.env.HIVE_BACKUP_DIR ?? path.join(path.dirname(dbPath), "backups"));
  try {
    const r = backupFile(dbPath, { dir, keep: Number(role ?? process.env.HIVE_BACKUP_KEEP ?? 7) });
    if (!r) throw new Error(`No database at ${dbPath}`);
    console.log(`${r.file}${r.removed.length ? `\nremoved ${r.removed.join(", ")}` : ""}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
} else {
  const hive = new SqliteHive(dbPath);
  const tokens = new TokenStore(hive.db);
  try {
    if (cmd === "create" && arg) {
      const { token, info } = tokens.create(arg, (role as Role) ?? "agent");
      console.log(`${info.name} (${info.role}, id ${info.id}):\n${token}`);
    } else if (cmd === "list") {
      console.table(tokens.list());
    } else if (cmd === "revoke" && arg) {
      tokens.revoke(arg);
      console.log(`revoked ${arg}`);
    } else {
      console.log("usage: token create <name> [viewer|agent|admin] | token list | token revoke <id> | backup [dir] [keep]");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    hive.close();
  }
}
