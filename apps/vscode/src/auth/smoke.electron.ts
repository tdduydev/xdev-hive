import assert from "node:assert/strict";
import { createServer } from "node:http";
import * as vscode from "vscode";
import { HiveAuthenticationProvider } from "@/auth/provider.ts";
import { secretKey, TokenStore } from "@/auth/store.ts";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("xdev.xdev-hive");
  assert.ok(extension);
  await extension.activate();
  const commands = await vscode.commands.getCommands();
  for (const name of ["xdevHive.signIn", "xdevHive.signOut", "xdevHive.setHubUrl"]) assert.ok(commands.includes(name));
  assert.equal(await vscode.authentication.getSession("xdev-hive", [], { silent: true }), undefined);

  const orgId = "12345678-1234-1234-1234-123456789abc";
  const token = `hive_pat_${orgId}_${"a".repeat(43)}`;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers["x-hive-org"], orgId);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/api/v1/me"
          ? { id: "dev", name: "Dev", email: "dev@example.com" }
          : { id: orgId, name: "Hive", role: "member" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const hub = `http://127.0.0.1:${address.port}`;
  const values = new Map([[secretKey(hub), token]]);
  const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  const secrets: vscode.SecretStorage = {
    get: async (key) => values.get(key),
    store: async (key, value) => {
      values.set(key, value);
      changed.fire({ key });
    },
    delete: async (key) => {
      values.delete(key);
      changed.fire({ key });
    },
    onDidChange: changed.event,
  };
  const provider = new HiveAuthenticationProvider(
    new TokenStore(
      secrets,
      async () => {
        throw new Error("ENOENT");
      },
      () => "missing",
    ),
    async () => hub,
  );
  const registration = vscode.authentication.registerAuthenticationProvider(
    "xdev-hive-auth-test",
    "Kiểm đăng nhập Hive",
    provider,
  );
  let additions = 0;
  const subscription = provider.onDidChangeSessions((event) => {
    additions += event.added?.length ?? 0;
  });
  try {
    const sessions = await provider.getSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.role, "member");
    assert.equal(additions, 1);
    console.log(
      "T011 Electron: activation, Accounts registration, silent empty session, restore and session event passed",
    );
  } finally {
    subscription.dispose();
    registration.dispose();
    provider.dispose();
    changed.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
