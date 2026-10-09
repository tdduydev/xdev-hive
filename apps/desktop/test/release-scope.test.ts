import assert from "node:assert/strict";
import { it } from "node:test";
import { changedSinceAppRelease, releaseScope } from "#desktop/scripts/release-scope.mjs";

it("keeps web and hub-only core tests out of desktop release", () => {
  assert.equal(releaseScope(["apps/web/src/app.ts", "packages/core/test/chat.test.ts", "deploy/update.sh"]).app, false);
});

it("releases desktop for shared runtime, UI, MCP and lockfile changes", () => {
  for (const file of ["apps/desktop/src/main/index.ts", "apps/desktop/src/preload/index.ts", "apps/desktop/src/main/runner/auto-release.ts", "packages/core/src/sqlite.ts", "packages/ui/src/pages/Chat.tsx", "packages/mcp/src/stdio.ts", "package-lock.json"]) {
    assert.equal(releaseScope(["apps/web/src/app.ts", file]).app, true, file);
  }
});

it("allows an explicit app release override", () => {
  assert.equal(releaseScope(["apps/web/src/app.ts"], true).app, true);
});

it("keeps the app tag as baseline across a hub-only deploy", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const repo = mkdtempSync(path.join(tmpdir(), "release-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    mkdirSync(path.join(repo, "apps/web/src"), { recursive: true });
    writeFileSync(path.join(repo, "apps/web/src/app.ts"), "a");
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "baseline");
    git("tag", "v1.0.0");
    writeFileSync(path.join(repo, "apps/web/src/app.ts"), "b");
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "hub change");
    assert.equal(changedSinceAppRelease(repo).app, false);
    mkdirSync(path.join(repo, "apps/desktop/src/main"), { recursive: true });
    writeFileSync(path.join(repo, "apps/desktop/src/main/index.ts"), "c");
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "app change");
    const scope = changedSinceAppRelease(repo);
    assert.equal(scope.baseline, "v1.0.0");
    assert.equal(scope.app, true);
    assert.deepEqual(scope.files, ["apps/desktop/src/main/index.ts", "apps/web/src/app.ts"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
