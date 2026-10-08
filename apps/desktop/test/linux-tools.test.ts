import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { agentProfileSchema } from "@xdev-hive/core";
import { insideRuntime, migrateProfiles, migrateRuntimeNode, runtimeRoots, toolBinDirs, toolsDir } from "#desktop/main/linux-tools.ts";

/** ~/hive-runtime/node-v<version>/ with node and a global codex, linked the way npm links it (relative). */
function runtimeNode(root: string, version: string) {
  const dir = path.join(root, `node-v${version}-linux-x64`);
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  mkdirSync(path.join(dir, "lib", "node_modules", "@openai", "codex", "bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin", "node"), "#!/bin/sh\n");
  chmodSync(path.join(dir, "bin", "node"), 0o755);
  writeFileSync(path.join(dir, "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), "// codex\n");
  symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", path.join(dir, "bin", "codex"));
  return dir;
}

const profile = (bin: string, env: Record<string, string> = {}) => agentProfileSchema.parse({ id: "codex-1", label: "Codex", kind: "codex", bin, args: ["exec", "{prompt}"], env });

describe("Linux CLIs out of the app's folder (BUG-cli-in-app-runtime)", () => {
  it("copies Node with its global CLIs to ~/.xdev-hive/tools, links kept, once", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "hive-tools-"));
    try {
      const root = path.join(home, "hive-runtime");
      mkdirSync(path.join(root, "app-0.146.1"), { recursive: true });
      const old = runtimeNode(root, "24.1.0");
      const moves = await migrateRuntimeNode(runtimeRoots(home, null), home);
      const to = path.join(toolsDir(home), "node-v24.1.0-linux-x64");
      assert.deepEqual(moves, [{ from: old, to }]);
      assert.equal(readlinkSync(path.join(to, "bin", "codex")), "../lib/node_modules/@openai/codex/bin/codex.js");
      assert.equal(readFileSync(path.join(to, "bin", "codex"), "utf8"), "// codex\n");
      assert.ok(existsSync(old), "the old folder stays for the person's shell");

      // Deleting the app's folder keeps the CLIs; a second start copies nothing and finds nothing to move.
      writeFileSync(path.join(to, "bin", "marker"), "");
      await migrateRuntimeNode(runtimeRoots(home, null), home);
      assert.ok(existsSync(path.join(to, "bin", "marker")), "an existing copy is not replaced");
      rmSync(root, { recursive: true, force: true });
      assert.deepEqual(await migrateRuntimeNode(runtimeRoots(home, null), home), []);
      assert.deepEqual(toolBinDirs(home), [path.join(to, "bin")]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("puts the newest Node first and looks in the running AppImage's root too", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "hive-tools-"));
    try {
      const layout = path.join(home, "apps", "hive");
      runtimeNode(layout, "22.9.0");
      runtimeNode(path.join(home, "hive-runtime"), "24.1.0");
      assert.deepEqual(runtimeRoots(home, layout), [layout, path.join(home, "hive-runtime")]);
      await migrateRuntimeNode(runtimeRoots(home, layout), home);
      assert.deepEqual(toolBinDirs(home), ["node-v24.1.0-linux-x64", "node-v22.9.0-linux-x64"].map((n) => path.join(toolsDir(home), n, "bin")));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("points profiles at the copy, absolute or ~/hive-runtime, bin and PATH-like env", () => {
    const home = "/home/u";
    const moves = [{ from: "/home/u/hive-runtime/node-v24.1.0-linux-x64", to: "/home/u/.xdev-hive/tools/node-v24.1.0-linux-x64" }];
    const [abs] = migrateProfiles([profile("/home/u/hive-runtime/node-v24.1.0-linux-x64/bin/codex")], moves, home)!;
    assert.equal(abs!.bin, "/home/u/.xdev-hive/tools/node-v24.1.0-linux-x64/bin/codex");
    const [short] = migrateProfiles([profile("~/hive-runtime/node-v24.1.0-linux-x64/bin/codex", { PATH: "~/hive-runtime/node-v24.1.0-linux-x64/bin:/usr/bin", CODEX_HOME: "~/.codex-2" })], moves, home)!;
    assert.equal(short!.bin, "~/.xdev-hive/tools/node-v24.1.0-linux-x64/bin/codex");
    assert.deepEqual(short!.env, { PATH: "~/.xdev-hive/tools/node-v24.1.0-linux-x64/bin:/usr/bin", CODEX_HOME: "~/.codex-2" });
    assert.equal(migrateProfiles([profile("codex"), profile("/home/u/hive-runtime-other/codex")], moves, home), null, "nothing else is touched");
  });

  it("tells a prefix inside the app's folder from one beside it", () => {
    assert.equal(insideRuntime("/home/u/hive-runtime/node-v24", ["/home/u/hive-runtime"]), true);
    assert.equal(insideRuntime("/home/u/hive-runtime-2/node", ["/home/u/hive-runtime"]), false);
    assert.equal(insideRuntime("/usr", []), false);
  });
});
