import assert from "node:assert/strict";
import { it } from "node:test";
import { changedSinceAppRelease, changedSinceAppReleaseAsync, releaseScope } from "#desktop/scripts/release-scope.mjs";
import { releaseScopeForBatch } from "#desktop/main/runner/auto-release.ts";
import type { DesktopProject } from "@xdev-hive/core";

it("keeps web and hub-only core tests out of desktop release", () => {
  assert.equal(releaseScope(["apps/web/src/app.ts", "packages/core/test/chat.test.ts", "deploy/update.sh"]).app, false);
});

it("releases desktop for shared runtime, UI, MCP and lockfile changes", () => {
  for (const file of ["apps/desktop/src/main/index.ts", "apps/desktop/src/preload/index.ts", "apps/desktop/src/main/runner/auto-release.ts", "packages/core/src/sqlite.ts", "packages/ui/src/pages/Chat.tsx", "packages/mcp/src/stdio.ts", "package.json", "package-lock.json", "packages/core/package.json", "packages/core/tsconfig.json", "packages/ui/package.json", "apps/desktop/tsconfig.json"]) {
    assert.equal(releaseScope(["apps/web/src/app.ts", file]).app, true, file);
  }
});

it("ignores a desktop manifest version-only bump, including with hub changes", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const repo = mkdtempSync(path.join(tmpdir(), "release-bump-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    mkdirSync(path.join(repo, "apps/desktop"), { recursive: true });
    writeFileSync(path.join(repo, "apps/desktop/package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "baseline"); git("tag", "v1.0.0");
    writeFileSync(path.join(repo, "apps/desktop/package.json"), '{"name":"fixture","version":"1.0.1"}\n');
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "bump");
    assert.equal(changedSinceAppRelease(repo).app, false);
    assert.equal((await changedSinceAppReleaseAsync(repo)).app, false);
    const project = { name: "fixture", repo } as DesktopProject;
    assert.equal(await releaseScopeForBatch("fixture", project, repo), "hub");
    assert.equal(await releaseScopeForBatch("another-project", project, repo), "app");
    mkdirSync(path.join(repo, "apps/web"), { recursive: true });
    writeFileSync(path.join(repo, "apps/web/app.ts"), "hub");
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "hub");
    assert.deepEqual(changedSinceAppRelease(repo).files, ["apps/web/app.ts"]);
    writeFileSync(path.join(repo, "apps/desktop/package.json"), '{"name":"fixture","version":"1.0.1","exports":"./main.js"}\n');
    git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "-m", "manifest dependency");
    assert.equal(changedSinceAppRelease(repo).app, true);
    assert.equal(await releaseScopeForBatch("fixture", project, repo), "app");
  } finally { rmSync(repo, { recursive: true, force: true }); }
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
