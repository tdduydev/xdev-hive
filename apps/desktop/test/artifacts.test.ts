// What a run leaves for the hub (roadmap 41c): the files in .xdev-hive/artifacts/, which no commit carries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ARTIFACT_DIR, ARTIFACTS_PER_RUN } from "@xdev-hive/core";
import { collectArtifacts } from "#desktop/main/runner/artifacts.ts";
import { branchPatch, commitAll, describeBranch } from "#desktop/main/runner/worktree.ts";

const sh = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function gitRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "hive-artifacts-"));
  sh(repo, ["init", "-q", "-b", "main"]);
  sh(repo, ["config", "user.email", "test@example.com"]);
  sh(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "init"]);
  return repo;
}

/** Writes `rel` under the worktree's artifacts folder. */
function artifact(dir: string, rel: string, bytes: Buffer | string): void {
  const file = path.join(dir, ARTIFACT_DIR, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
}

describe("the files a run makes (roadmap 41c)", () => {
  it("picks up what the agent left, folders and all", () => {
    const dir = gitRepo();
    artifact(dir, "report.md", "# Đã đo\n");
    artifact(dir, "shots/board.png", PNG);
    artifact(dir, "numbers.json", '{"ms":12}\n');
    const { files, skipped } = collectArtifacts(dir);
    assert.deepEqual(skipped, []);
    assert.deepEqual(files.map((f) => f.name).sort(), ["numbers.json", "report.md", "shots/board.png"]);
    const shot = files.find((f) => f.name === "shots/board.png")!;
    assert.deepEqual(Buffer.from(shot.data, "base64"), PNG, "the bytes go as they are");
    assert.equal(shot.size, PNG.length);
    assert.equal(shot.file, path.join(dir, ARTIFACT_DIR, "shots/board.png"), "where to delete it once the hub has it");
  });

  it("leaves behind a file that is too big or not a kind the hub keeps, and says why", () => {
    const dir = gitRepo();
    artifact(dir, "ok.md", "# fine\n");
    artifact(dir, "huge.log", Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    artifact(dir, "bundle.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]));
    artifact(dir, "empty.md", "");
    const { files, skipped } = collectArtifacts(dir);
    assert.deepEqual(files.map((f) => f.name), ["ok.md"]);
    assert.equal(skipped.length, 3);
    assert.match(skipped.join("\n"), /bundle\.zip/);
    assert.match(skipped.join("\n"), /empty\.md/);
    assert.match(skipped.join("\n"), /huge\.log.*5 MB/s);
  });

  it("keeps at most twenty and writes a line about the rest", () => {
    const dir = gitRepo();
    for (let n = 0; n < ARTIFACTS_PER_RUN + 3; n++) artifact(dir, `f${String(n).padStart(2, "0")}.md`, `# ${n}\n`);
    const { files, skipped } = collectArtifacts(dir);
    assert.equal(files.length, ARTIFACTS_PER_RUN);
    // Path order, so two runs of the same work send the same twenty.
    assert.deepEqual(files.map((f) => f.name), files.map((f) => f.name).sort());
    assert.equal(files[0]!.name, "f00.md");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /3/);
  });

  it("sends nothing when the artifacts folder is a link out of the worktree, so cleanup cannot delete what it points at", () => {
    const dir = gitRepo();
    const outside = mkdtempSync(path.join(os.tmpdir(), "hive-outside-"));
    writeFileSync(path.join(outside, "keep.md"), "# not the agent's\n");
    mkdirSync(path.join(dir, ".xdev-hive"), { recursive: true });
    symlinkSync(outside, path.join(dir, ARTIFACT_DIR), "dir");
    const { files, skipped } = collectArtifacts(dir);
    assert.deepEqual(files, []);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /symlink/);
    assert.ok(existsSync(path.join(outside, "keep.md")));
  });

  it("does not follow a link to a file or a folder inside the artifacts folder", () => {
    const dir = gitRepo();
    const outside = mkdtempSync(path.join(os.tmpdir(), "hive-outside-"));
    writeFileSync(path.join(outside, "secret.txt"), "not for the hub\n");
    artifact(dir, "ok.md", "# fine\n");
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, ARTIFACT_DIR, "secret.txt"));
    symlinkSync(outside, path.join(dir, ARTIFACT_DIR, "shots"), "dir");
    const { files, skipped } = collectArtifacts(dir);
    assert.deepEqual(files.map((f) => f.name), ["ok.md"]);
    assert.equal(skipped.length, 2, skipped.join("\n"));
    assert.match(skipped.join("\n"), /secret\.txt.*symlink/s);
  });

  it("keeps the first of two paths that come out as the same name, and leaves the other on disk", () => {
    const dir = gitRepo();
    artifact(dir, ".report.md", "# hidden\n");
    artifact(dir, "report.md", "# shown\n");
    const { files, skipped } = collectArtifacts(dir);
    assert.deepEqual(files.map((f) => [f.name, f.file]), [["report.md", path.join(dir, ARTIFACT_DIR, ".report.md")]]);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /report\.md.*\.report\.md/s);
  });

  it("finds nothing when the agent made nothing", () => {
    assert.deepEqual(collectArtifacts(gitRepo()), { files: [], skipped: [] });
  });

  it("stays out of the commit, the diff and what counts as uncommitted", () => {
    const dir = gitRepo();
    const base = sh(dir, ["rev-parse", "HEAD"]).trim();
    artifact(dir, "shots/board.png", PNG);
    artifact(dir, "report.md", "# Đã đo\n");
    writeFileSync(path.join(dir, "work.txt"), "done\n");

    const c = commitAll(dir, "ai(T-1): work", []);
    assert.equal(c.error, null);
    assert.deepEqual(sh(dir, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n"), ["work.txt"]);
    assert.match(sh(dir, ["status", "--porcelain", "--untracked-files=all"]), /\?\? \.xdev-hive\/artifacts\//, "still on disk for the runner to send");
    assert.doesNotMatch(describeBranch(dir, base), /artifacts/);
    assert.doesNotMatch(branchPatch(dir, base), /artifacts/);
  });
});
