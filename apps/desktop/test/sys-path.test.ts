import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { it } from "node:test";
import { resolveBin } from "#desktop/main/runner/command.ts";
import { sysBin } from "#desktop/test/fixtures/sys-path.ts";

it("exposes shell/Git utilities without discovering host agent CLIs or installers", () => {
  const bin = sysBin();
  assert.deepEqual(readdirSync(bin).sort(), ["cat", "chmod", "cp", "env", "git", "mkdir", "rm", "sh"]);
  for (const utility of ["sh", "git", "mkdir", "chmod", "cat", "cp", "env", "rm"]) {
    assert.ok(resolveBin(utility, bin), utility);
  }
  for (const tool of ["claude", "codex", "gemini", "agy", "docker", "npm", "npx", "uv", "specify", "security"]) {
    assert.equal(resolveBin(tool, bin), null, `${tool} must come from an explicit fixture`);
  }
});
