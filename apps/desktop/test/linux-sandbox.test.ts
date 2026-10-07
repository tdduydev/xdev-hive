import assert from "node:assert/strict";
import { it } from "node:test";
import { linuxSandboxFallback } from "#desktop/main/linux-sandbox.ts";

// Injected reads keep the test off the host's real sysctl and helper.
const sysctl = (value: string | null) => ((file: string) => {
  if (value === null) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
  return value;
}) as never;
const helper = (st: { uid: number; mode: number } | null) => ((file: string) => {
  if (!st) throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
  return st;
}) as never;

it("keeps Chromium's sandbox only when the host lets it run (BUG-linux-appimage)", () => {
  const exe = "/opt/app/xdev-hive";
  assert.equal(linuxSandboxFallback(exe, sysctl("1\n"), helper({ uid: 0, mode: 0o104755 })), "AppArmor restricts unprivileged user namespaces");
  assert.equal(linuxSandboxFallback(exe, sysctl(null), helper({ uid: 0, mode: 0o104755 })), null, "a setuid root helper works");
  assert.equal(linuxSandboxFallback(exe, sysctl("0"), helper({ uid: 0, mode: 0o104755 })), null);
  assert.equal(linuxSandboxFallback(exe, sysctl("0"), helper({ uid: 1000, mode: 0o104755 })), "chrome-sandbox is not root-owned setuid");
  assert.equal(linuxSandboxFallback(exe, sysctl("0"), helper({ uid: 0, mode: 0o100755 })), "chrome-sandbox is not root-owned setuid");
  assert.equal(linuxSandboxFallback(exe, sysctl("0"), helper(null)), "chrome-sandbox is missing");
});
