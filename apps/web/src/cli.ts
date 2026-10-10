// Hub admin from the server shell (e.g. when nobody can sign in):
//   npm run token -w @xdev-hive/web -- create <name> <owner username> [viewer|agent|member|release]
//     Every token has an owner and acts as a member at most (spec 79a): administering is for a person on the hub's page.
//     release: a token for release.mjs (HIVE_RELEASE_TOKEN) that uploads desktop builds only; its owner must be an admin.
//   npm run token -w @xdev-hive/web -- list
//   npm run token -w @xdev-hive/web -- revoke <id>
//   npm run user -w @xdev-hive/web -- create <username> [admin]   (prints a temporary password)
//   npm run user -w @xdev-hive/web -- reset <username>            (new temporary password, signs out everywhere)
//   npm run user -w @xdev-hive/web -- list
//   npm run backup -w @xdev-hive/web -- [dir] [keep]   (default HIVE_BACKUP_DIR, else data/backups; keep 7)
//   npm run files -w @xdev-hive/web -- restore [dir]   (puts backed-up stored files, <dir>/files, back into HIVE_SEAWEEDFS_URL)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Role } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { SHA256_HEX } from "@xdev-hive/core";
import { backupFile, DEFAULT_PIN_DAYS, filesDir } from "./backup.ts";
import { seaweedFromEnv } from "./seaweed.ts";
import { TokenStore } from "./tokens.ts";
import { UserStore } from "./users.ts";

/**
 * A token from the server shell: always of an account (spec 79a), never admin. A release token's owner is checked here
 * too, though the hub would ignore its flag once that person is no admin.
 */
function createToken(tokens: TokenStore, users: UserStore, name: string, owner: string | undefined, kind: string | undefined) {
  if (!owner) throw new Error("A token needs an owner: token create <name> <owner username> [viewer|agent|member|release]");
  const user = users.list().find((u) => u.username === owner.toLowerCase());
  if (!user || user.disabled) throw new Error(`No active account ${owner}`);
  if (kind === "admin") throw new Error("No token is admin (spec 79a): administer on the hub's page; a token acts as a member at most.");
  if (kind === "release") {
    if (!user.admin) throw new Error(`${owner} is not a hub admin: only an admin's token uploads releases.`);
    return tokens.create(name, "viewer", user.id, { releaseUpload: true });
  }
  const role = (kind ?? "agent") as Role;
  if (!["viewer", "agent", "member"].includes(role)) throw new Error("Role must be one of viewer, agent, member, release");
  return tokens.create(name, role, user.id);
}

const dbPath = path.resolve(process.env.HIVE_DB ?? path.join(import.meta.dirname, "..", "data", "hub.db"));
const [cmd, sub, arg, extra, more] = process.argv.slice(2);

// Backup reads the file as it is: no SqliteHive, so an older database is not migrated first.
if (cmd === "backup") {
  const dir = path.resolve(sub ?? process.env.HIVE_BACKUP_DIR ?? path.join(path.dirname(dbPath), "backups"));
  try {
    // Asked for by hand, like "Backup ngay": pinned out of the rotation for the same days.
    const pinDays = Number(process.env.HIVE_BACKUP_PIN_DAYS ?? DEFAULT_PIN_DAYS);
    const r = backupFile(dbPath, { dir, keep: Number(arg ?? process.env.HIVE_BACKUP_KEEP ?? 7), reason: "manual", pin: true, pinDays, by: "cli" });
    if (!r) throw new Error(`No database at ${dbPath}`);
    console.log(`${r.file}${r.removed.length ? `\nremoved ${r.removed.join(", ")}` : ""}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
} else if (cmd === "files" && sub === "restore") {
  // SeaweedFS lost its data: every stored file in the backup goes back, checked against its SHA-256 name.
  const dir = path.resolve(arg ?? process.env.HIVE_BACKUP_DIR ?? path.join(path.dirname(dbPath), "backups"));
  try {
    const store = seaweedFromEnv(process.env);
    if (!store) throw new Error("Set HIVE_SEAWEEDFS_URL to the filer to restore into.");
    let put = 0;
    for (const name of readdirSync(filesDir(dir)).filter((f) => SHA256_HEX.test(f))) {
      const bytes = new Uint8Array(readFileSync(path.join(filesDir(dir), name)));
      if (createHash("sha256").update(bytes).digest("hex") !== name) {
        console.error(`skipped ${name}: its bytes do not match its name`);
        continue;
      }
      await store.put(name, bytes, "application/octet-stream");
      put++;
    }
    console.log(`${put} files put back into ${store.where}`);
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
      hive.audit(cli, "users.create", user.username, user.admin ? "admin" : "member", { key: user.admin ? "role.admin" : "role.member" });
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
      const { token, info } = createToken(tokens, users, arg, extra, more);
      console.log(`${info.name} (${info.releaseUpload ? "release upload" : info.role}, owner ${extra}, id ${info.id}):\n${token}`);
    } else if (cmd === "token" && sub === "list") {
      console.table(tokens.list());
    } else if (cmd === "token" && sub === "revoke" && arg) {
      tokens.revoke(arg);
      console.log(`revoked ${arg}`);
    } else {
      console.log("usage: token create <name> <owner> [viewer|agent|member|release] | token list | token revoke <id> | user create <username> [admin] | user reset <username> | user list | backup [dir] [keep]");
      process.exitCode = 1;
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    hive.close();
  }
}
