import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

it("Linux installer ignores Electron Node helpers but still blocks a running app", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "hive-install-test-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore" });
  await once(helper, "spawn");
  try {
    const executable = (file: string, text: string) => writeFileSync(file, `#!/bin/sh\n${text}\n`, { mode: 0o755 });
    executable(path.join(bin, "pgrep"), 'printf "%s\\n" "$*" > "$HOME/pgrep-args"; printf "%s\\n" "$FIXTURE_PIDS"');
    executable(path.join(bin, "update-desktop-database"), "exit 0");
    executable(path.join(bin, "dpkg-query"), "exit 1");
    const image = path.join(root, "fixture.AppImage");
    executable(image, 'mkdir squashfs-root; printf "#!/bin/sh\\nexit 0\\n" > squashfs-root/AppRun; chmod +x squashfs-root/AppRun; printf "[Desktop Entry]\\nX-AppImage-Version=0.0.1\\nExec=AppRun\\n" > squashfs-root/hive.desktop');
    const installer = path.resolve(import.meta.dirname, "../scripts/install-linux.sh");
    const env = { ...process.env, HOME: root, XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"), PATH: `${bin}:${process.env.PATH}` };
    const run = (pids: string) => spawnSync("sh", [installer, image, "--no-start"], { env: { ...env, FIXTURE_PIDS: pids }, encoding: "utf8" });
    const blocked = run(`${helper.pid}\n${process.pid}`);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /xDev Hive is running/);
    assert.equal(existsSync(path.join(root, "data/xdev-hive/current")), false);
    const installed = run(String(helper.pid));
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(realpathSync(path.join(root, "data/xdev-hive/current")), path.join(root, "data/xdev-hive/app-0.0.1"));
    assert.equal(readFileSync(path.join(root, "pgrep-args"), "utf8").trim(), `-u ${process.getuid!()} -x xdev-hive`);
    assert.equal(helper.exitCode, null);
  } finally {
    helper.kill();
    await once(helper, "exit");
    rmSync(root, { recursive: true, force: true });
  }
});
