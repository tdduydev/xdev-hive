// Hub admin from the server shell (e.g. when nobody can sign in):
//   npm run token -w @xdev-hive/web -- create <name> [viewer|agent|admin]
//   npm run token -w @xdev-hive/web -- list
//   npm run token -w @xdev-hive/web -- revoke <id>
//   npm run user -w @xdev-hive/web -- create <username> [admin]   (prints a temporary password)
//   npm run user -w @xdev-hive/web -- reset <username>            (new temporary password, signs out everywhere)
//   npm run user -w @xdev-hive/web -- list
//   npm run backup -w @xdev-hive/web -- [dir] [keep]   (default HIVE_BACKUP_DIR, else data/backups; keep 7)
import path from "node:path";
import type { Role } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { backupFile } from "./backup.ts";
import { TokenStore } from "./tokens.ts";
import { UserStore } from "./users.ts";

const dbPath = path.resolve(process.env.HIVE_DB ?? path.join(import.meta.dirname, "..", "data", "hub.db"));
const [cmd, sub, arg, extra] = process.argv.slice(2);

// Backup reads the file as it is: no SqliteHive, so an older database is not migrated first.
if (cmd === "backup") {
  const dir = path.resolve(sub ?? process.env.HIVE_BACKUP_DIR ?? path.join(path.dirname(dbPath), "backups"));
  try {
    const r = backupFile(dbPath, { dir, keep: Number(arg ?? process.env.HIVE_BACKUP_KEEP ?? 7) });
    if (!r) throw new Error(`No database at ${dbPath}`);
    console.log(`${r.file}${r.removed.length ? `\nremoved ${r.removed.join(", ")}` : ""}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
} else {
  const hive = new SqliteHive(dbPath);
  const tokens = new TokenStore(hive.db);
  const users = new UserStore(hive.db);
  const cli = { name: "cli", role: "admin" as const };
  try {
    if (cmd === "user" && sub === "create" && arg) {
      const { user, password } = users.create({ username: arg, admin: extra === "admin" });
      hive.audit(cli, "users.create", user.username, user.admin ? "admin" : "member");
      console.log(`${user.username}${user.admin ? " (admin)" : ""}: temporary password\n${password}`);
    } else if (cmd === "user" && sub === "reset" && arg) {
      const user = users.list().find((u) => u.username === arg.toLowerCase());
      if (!user) throw new Error(`No account ${arg}`);
      const password = users.resetPassword(user.id);
      hive.audit(cli, "users.resetPassword", user.username);
      console.log(`${user.username}: temporary password\n${password}`);
    } else if (cmd === "user" && sub === "list") {
      console.table(users.list().map((u) => ({ username: u.username, admin: u.admin, disabled: u.disabled, projects: Object.keys(u.grants).join(" ") })));
    } else if (cmd === "token" && sub === "create" && arg) {
      const { token, info } = tokens.create(arg, (extra as Role) ?? "agent");
      console.log(`${info.name} (${info.role}, id ${info.id}):\n${token}`);
    } else if (cmd === "token" && sub === "list") {
      console.table(tokens.list());
    } else if (cmd === "token" && sub === "revoke" && arg) {
      tokens.revoke(arg);
      console.log(`revoked ${arg}`);
    } else {
      console.log("usage: token create <name> [role] | token list | token revoke <id> | user create <username> [admin] | user reset <username> | user list | backup [dir] [keep]");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    hive.close();
  }
}
