// Token admin from the server shell (e.g. when the admin token is lost):
//   npm run token -w @xdev-hive/web -- create <name> [viewer|agent|admin]
//   npm run token -w @xdev-hive/web -- list
//   npm run token -w @xdev-hive/web -- revoke <id>
import path from "node:path";
import type { Role } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { TokenStore } from "./tokens.ts";

const dbPath = path.resolve(process.env.HIVE_DB ?? path.join(import.meta.dirname, "..", "data", "hub.db"));
const hive = new SqliteHive(dbPath);
const tokens = new TokenStore(hive.db);
const [cmd, arg, role] = process.argv.slice(2);

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
    console.log("usage: token create <name> [viewer|agent|admin] | token list | token revoke <id>");
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  hive.close();
}
