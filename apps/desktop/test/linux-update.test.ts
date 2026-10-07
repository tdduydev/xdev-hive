import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { extractedInstallScript, extractLinuxUpdate, linuxLayout, linuxUpdateService, updateCommand, type UpdateCommand } from "#desktop/main/linux-update.ts";

const dirs: string[] = [];
function layout() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "hive-linux-update-")));
  dirs.push(root);
  const app = path.join(root, "app-0.141.0");
  mkdirSync(app);
  writeFileSync(path.join(app, "xdev-hive"), "old build");
  writeFileSync(path.join(app, "AppRun"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(app, "AppRun"), 0o755);
  const current = path.join(root, "current");
  symlinkSync(app, current);
  return { root, app, current };
}

after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe("extracted Linux app updates", () => {
  it("recognizes only a current symlink pointing to the running app directory", () => {
    const l = layout();
    assert.deepEqual(linuxLayout(path.join(l.current, "xdev-hive")), l);
    rmSync(l.current);
    assert.equal(linuxLayout(path.join(l.app, "xdev-hive")), null);
    mkdirSync(l.current);
    assert.equal(linuxLayout(path.join(l.app, "xdev-hive")), null);
  });

  it("extracts in a temporary stage on the same filesystem and leaves current on the old build", async () => {
    const l = layout();
    const image = path.join(l.root, "new.AppImage");
    // A harmless executable fixture exercises the real exec/extract path on any POSIX test host.
    writeFileSync(image, '#!/bin/sh\n[ "$1" = --appimage-extract ] || exit 2\nmkdir squashfs-root\nprintf "#!/bin/sh\\nexit 0\\n" > squashfs-root/AppRun\nchmod +x squashfs-root/AppRun\n');
    const target = await extractLinuxUpdate(l, image, "0.142.0", updateCommand);
    assert.equal(target, path.join(l.root, "app-0.142.0"));
    assert.ok(existsSync(path.join(target, "AppRun")));
    assert.equal(realpathSync(l.current), l.app);
    assert.ok(!readdirSync(l.root).some((f) => f.startsWith(".update-")));
    await assert.rejects(() => extractLinuxUpdate(l, image, "0.142.0", updateCommand), /already exists/);
  });

  it("cleans partial extraction and rejects invalid launchers/versions without changing current", async () => {
    for (const mode of ["missing", "outside", "failure"]) {
      const l = layout();
      const image = path.join(l.root, "new.AppImage");
      writeFileSync(image, "fixture");
      const extract: UpdateCommand = async (_file, _args, opts) => {
        mkdirSync(path.join(opts.cwd!, "squashfs-root"));
        if (mode === "outside") symlinkSync(path.join(l.app, "AppRun"), path.join(opts.cwd!, "squashfs-root", "AppRun"));
        if (mode === "failure") throw new Error("extract failed");
        return { stdout: "" };
      };
      await assert.rejects(() => extractLinuxUpdate(l, image, "0.142.0", extract));
      await assert.rejects(() => extractLinuxUpdate(l, image, "../../escape", extract), /Invalid/);
      assert.equal(realpathSync(l.current), l.app);
      assert.equal(existsSync(path.join(l.root, "app-0.142.0")), false);
      assert.ok(!readdirSync(l.root).some((f) => f.startsWith(".update-")));
    }
  });

  it("identifies the app service by its matching cgroup, including a wrapper MainPID without contacting a real manager", async () => {
    const l = layout();
    const calls: string[][] = [];
    const run: UpdateCommand = async (_cmd, args) => {
      calls.push(args);
      return { stdout: args.includes("--property=ExecStart") ? `${l.root}/current/AppRun` : args.includes("--user") ? "/user.slice/user-1000.slice/user@1000.service/app.slice/xdev-hive.service" : "" };
    };
    assert.deepEqual(await linuxUpdateService(run, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/xdev-hive.service\n", l), { unit: "xdev-hive.service", user: true });
    assert.equal(calls.length, 2);
    assert.equal(await linuxUpdateService(run, "0::/\n", l), null);
    await assert.rejects(() => linuxUpdateService(async () => ({ stdout: "42" }), "0::/system.slice/hive.service", l), /Cannot identify/);
    for (const launcher of ["/usr/sbin/sshd", `${l.app}/AppRun`]) {
      await assert.rejects(() => linuxUpdateService(async (_cmd, args) => ({ stdout: args.includes("--property=ExecStart") ? launcher : "/system.slice/ssh.service" }), "0::/system.slice/ssh.service", l), /ExecStart/, "never stop SSH or restart a hardcoded old app path");
    }
  });

  it("executes the Linux helper in a temp runtime, switches current, and rolls back if restart fails", { skip: process.platform !== "linux" ? "helper uses GNU mv -T; extraction and systemd scheduling are tested on every POSIX host" : false }, async () => {
    for (const fail of [false, true]) {
      const l = layout();
      const next = path.join(l.root, "app-0.142.0");
      mkdirSync(next);
      const bin = path.join(l.root, "bin");
      mkdirSync(bin);
      const calls = path.join(l.root, "calls");
      writeFileSync(path.join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n[ "$FAIL" = 1 ] && [ "$2" = restart ] && exit 1\nexit 0\n');
      chmodSync(path.join(bin, "systemctl"), 0o755);
      const script = path.join(l.root, "install.sh");
      writeFileSync(script, extractedInstallScript);
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const result = promisify(execFile)("/bin/sh", [script], { env: { PATH: `${bin}:/usr/bin:/bin`, PID: "2147483647", NEW: next, OLD: l.app, CURRENT: l.current, UNIT: "fake.service", USER_MANAGER: "1", RELAUNCH: "1", LOG: path.join(l.root, "install.log"), ERROR: path.join(l.root, "install-error"), CALLS: calls, FAIL: fail ? "1" : "0" } });
      if (fail) await assert.rejects(() => result); else await result;
      assert.equal(realpathSync(l.current), fail ? l.app : next);
      assert.match(readFileSync(calls, "utf8"), /--user stop fake.service\n--user restart fake.service/);
      if (fail) assert.match(readFileSync(path.join(l.root, "install-error"), "utf8"), /restored old build/);
    }
  });
});
