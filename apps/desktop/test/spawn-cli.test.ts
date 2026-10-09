import assert from "node:assert/strict";
import { it } from "node:test";
import { promptOnStdin } from "#desktop/main/runner/command.ts";
import { cliLaunch, resolveBin } from "#desktop/main/spawn-cli.ts";

const nodeDir = "C:\\Program Files\\nodejs";
// npm's layout on Windows: an sh script with no extension beside the .cmd shim.
const files = new Set([`${nodeDir}\\npx`, `${nodeDir}\\npx.cmd`, `${nodeDir}\\npx.ps1`, "C:\\tools\\claude.exe", "C:\\npm\\claude.cmd"]);
const win = { platform: "win32" as const, pathext: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1", isFile: (f: string) => files.has(f) };

it("resolveBin on Windows picks npm's .cmd shim, never the extensionless sh script (spawn npx ENOENT)", () => {
  assert.equal(resolveBin("npx", `C:\\Windows;${nodeDir}`, win), `${nodeDir}\\npx.cmd`);
  assert.equal(resolveBin(`${nodeDir}\\npx`, "", win), `${nodeDir}\\npx.cmd`);
  assert.equal(resolveBin(`${nodeDir}\\npx.cmd`, "", win), `${nodeDir}\\npx.cmd`);
  // .ps1 is in PATHEXT but Node cannot start it.
  assert.equal(resolveBin("npx", nodeDir, { ...win, isFile: (f) => f.endsWith(".ps1") }), null);
  // A native .exe earlier on PATH wins over a later npm shim.
  assert.equal(resolveBin("claude", "C:\\tools;C:\\npm", win), "C:\\tools\\claude.exe");
  assert.equal(resolveBin("npx", "/usr/bin", { platform: "linux", isFile: (f) => f === "/usr/bin/npx" }), "/usr/bin/npx");
});

it("cliLaunch runs a .cmd through cmd.exe with every argument quoted and escaped twice for the shim's %*", () => {
  const l = cliLaunch(`${nodeDir}\\npx.cmd`, ["-y", "@colbymchenry/codegraph@1.2.3", "init", "D:\\my repo"], { platform: "win32", comspec: "C:\\Windows\\system32\\cmd.exe" });
  assert.equal(l.bin, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(l.windowsVerbatimArguments, true);
  assert.deepEqual(l.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(l.args[3], `"C:\\Program^ Files\\nodejs\\npx.cmd ^^^"-y^^^" ^^^"@colbymchenry/codegraph@1.2.3^^^" ^^^"init^^^" ^^^"D:\\my^^^ repo^^^""`);
  assert.match(cliLaunch("C:\\x.cmd", ["a&calc"], { platform: "win32" }).args[3]!, /\^\^\^&/);
  assert.throws(() => cliLaunch("C:\\x.cmd", ["two\nlines"], { platform: "win32" }), /line break/);
  assert.deepEqual(cliLaunch("C:\\tools\\claude.exe", ["-p"], { platform: "win32" }), { bin: "C:\\tools\\claude.exe", args: ["-p"] });
  assert.deepEqual(cliLaunch("/usr/bin/npx", ["x y"], { platform: "darwin" }), { bin: "/usr/bin/npx", args: ["x y"] });
});

it("promptOnStdin moves a multi-line prompt to stdin for Claude and Codex, which cmd.exe cannot carry as an argument", () => {
  const prompt = "line 1\nline 2";
  assert.deepEqual(promptOnStdin("claude", ["-p", prompt, "--permission-mode", "acceptEdits"], null), { args: ["-p", "--permission-mode", "acceptEdits"], stdin: prompt });
  assert.deepEqual(promptOnStdin("codex", ["exec", "--sandbox", "workspace-write", prompt, "-c", "x=1"], null), { args: ["exec", "--sandbox", "workspace-write", "-", "-c", "x=1"], stdin: prompt });
  // Already on stdin (Claude's stream-json input), a one-line prompt, or a kind without a stdin form: unchanged.
  assert.deepEqual(promptOnStdin("claude", ["-p", "--input-format", "stream-json"], "{}"), { args: ["-p", "--input-format", "stream-json"], stdin: "{}" });
  assert.deepEqual(promptOnStdin("claude", ["-p", "short"], null), { args: ["-p", "short"], stdin: null });
  assert.deepEqual(promptOnStdin("opencode", ["run", prompt], null), { args: ["run", prompt], stdin: null });
});
