import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

it("Linux installer preserves helpers and supports graceful or explicit forced app shutdown", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-install-test-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore" });
  await once(helper, "spawn");
  const children = [helper];
  try {
    const executable = (file: string, text: string) => writeFileSync(file, `#!/bin/sh\n${text}\n`, { mode: 0o755 });
    executable(path.join(bin, "pgrep"), 'printf "%s\\n" "$*" > "$HOME/pgrep-args"; printf "%s\\n" "$FIXTURE_PIDS"');
    executable(path.join(bin, "update-desktop-database"), "exit 0");
    executable(path.join(bin, "dpkg-query"), "exit 1");
    // Bound waits remain covered without making a stubborn-process fixture take 30 seconds.
    executable(path.join(bin, "sleep"), "/bin/sleep 0.02");
    const image = path.join(root, "fixture.AppImage");
    executable(image, 'mkdir squashfs-root; printf "#!/bin/sh\\nexit 0\\n" > squashfs-root/AppRun; chmod +x squashfs-root/AppRun; printf "[Desktop Entry]\\nX-AppImage-Version=0.0.1\\nExec=AppRun\\n" > squashfs-root/hive.desktop');
    const installer = path.resolve(import.meta.dirname, "../scripts/install-linux.sh");
    const env = { ...process.env, HOME: root, XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), PATH: `${bin}:${process.env.PATH}` };
    const run = (pids: string, ...flags: string[]) => spawnSync("sh", [installer, image, "--no-start", ...flags], { env: { ...env, FIXTURE_PIDS: pids }, encoding: "utf8" });
    const blocked = run(`${helper.pid}\n${process.pid}`);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /xDev Hive is running/);
    assert.equal(existsSync(path.join(root, "data/xdev-hive/current")), false);
    const installed = run(String(helper.pid));
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(realpathSync(path.join(root, "data/xdev-hive/current")), path.join(root, "data/xdev-hive/app-0.0.1"));
    assert.equal(readFileSync(path.join(root, "pgrep-args"), "utf8").trim(), `-u ${process.getuid!()} -x xdev-hive`);
    assert.equal(helper.exitCode, null);
    const app = async (stubborn: boolean, renderer = false) => {
      const child = spawn(process.execPath, ["-e", `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {
          fs.writeFileSync(process.env.MARKER, 'TERM');
          ${stubborn ? "" : "setTimeout(() => process.exit(0), 50);"}
        });
        console.log('ready'); setInterval(() => {}, 1000);
      `, "--", ...(renderer ? ["--type=renderer"] : [])], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "0", MARKER: path.join(root, "term") }, stdio: ["ignore", "pipe", "ignore"] });
      children.push(child);
      await once(child.stdout!, "data");
      return child;
    };
    const renderer = await app(true, true);
    const graceful = await app(false);
    const gracefulExit = once(graceful, "exit");
    const closed = run(`${helper.pid}\n${renderer.pid}\n${graceful.pid}`, "--quit-running");
    assert.equal(closed.status, 0, closed.stderr);
    assert.deepEqual(await gracefulExit, [0, null]);
    assert.equal(readFileSync(path.join(root, "term"), "utf8"), "TERM");
    assert.equal(renderer.exitCode, null);
    const stuck = await app(true);
    const timedOut = run(String(stuck.pid), "--quit-running");
    assert.equal(timedOut.status, 1);
    assert.match(timedOut.stderr, /--force-quit/);
    assert.equal(stuck.exitCode, null);
    const forcedExit = once(stuck, "exit");
    const forced = run(`${helper.pid}\n${stuck.pid}`, "--force-quit");
    assert.equal(forced.status, 0, forced.stderr);
    assert.deepEqual(await forcedExit, [null, "SIGKILL"]);
    assert.equal(helper.exitCode, null);
    const untouched = await app(false);
    writeFileSync(image, "#!/bin/sh\nexit 1\n");
    assert.notEqual(run(String(untouched.pid), "--force-quit").status, 0);
    assert.equal(untouched.exitCode, null, "invalid build must not close the app");
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
