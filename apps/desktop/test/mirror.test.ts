import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { mirrorDocs, mirrors } from "#desktop/main/mirror.ts";

const admin: Actor = { name: "duy", role: "admin" };
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function repoWith(files: Record<string, string>) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "hive-mirror-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "Test");
  const write = (all: Record<string, string>, message: string) => {
    for (const [f, text] of Object.entries(all)) {
      mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
      writeFileSync(path.join(repo, f), text);
    }
    git(repo, "add", ".");
    git(repo, "commit", "-qm", message);
    return git(repo, "rev-parse", "--short", "HEAD");
  };
  return { repo, write, first: write(files, "init") };
}

const CONFIG = JSON.stringify({ docs: [{ file: "README.md", split: "##", folder: "huong-dan", folderTitle: "Hướng dẫn" }] });

describe("mirroring the repo's docs into Hive (roadmap 26)", () => {
  it("makes the pages once, writes a new version only for what a commit changed, and never sends what is not committed", async () => {
    const { repo, write, first } = repoWith({ ".xdev-hive/docs.json": CONFIG, "README.md": "# Demo\n\n## Chạy\n\nnpm ci\n\n## Deploy\n\nupdate.sh\n" });
    const hive = new SqliteHive(":memory:");
    const project = { name: "demo", repo };
    assert.equal(mirrors(repo), true);

    const one = await mirrorDocs(hive, admin, project, { fetch: false });
    assert.deepEqual([one.commit, one.changed.sort()], [first, ["project/demo/chay", "project/demo/deploy", "project/demo/huong-dan"]]);
    const chay = await hive.call("docs.get", { key: "project/demo/chay" }, admin);
    assert.deepEqual([chay?.content, chay?.parent, chay?.mirror], ["npm ci\n", "project/demo/huong-dan", { from: "README.md#Chạy", commit: first }]);
    assert.equal((await hive.call("docs.get", { key: "project/demo/huong-dan" }, admin))?.folder, true);

    const again = await mirrorDocs(hive, admin, project, { fetch: false });
    assert.deepEqual([again.changed, again.unchanged], [[], 3], "the same commit changes nothing");
    assert.equal((await mirrorDocs(hive, admin, project, { fetch: false, since: first })).unchanged, 0, "since: not even read");

    // Someone still writing: their checkout is not what goes to Hive.
    writeFileSync(path.join(repo, "README.md"), "# Demo\n\n## Chạy\n\nnpm ci --draft\n\n## Deploy\n\nupdate.sh\n");
    assert.deepEqual((await mirrorDocs(hive, admin, project, { fetch: false })).changed, []);

    const next = write({ "README.md": "# Demo\n\n## Chạy\n\nnpm ci && npm test\n\n## Deploy\n\nupdate.sh\n" }, "docs: test too");
    const changed = await mirrorDocs(hive, admin, project, { fetch: false });
    assert.deepEqual(changed.changed, ["project/demo/chay"]);
    const v2 = await hive.call("docs.get", { key: "project/demo/chay" }, admin);
    assert.deepEqual([v2?.version, v2?.content, v2?.mirror?.commit], [2, "npm ci && npm test\n", next]);
    const history = await hive.call("docs.history", { key: "project/demo/chay" }, admin);
    assert.equal(history[0]?.note, `Từ repo README.md#Chạy @ ${next}`);
  });

  it("does nothing for a repo without a config, and says which files it names are missing", async () => {
    const plain = repoWith({ "README.md": "# Demo\n" });
    assert.equal(mirrors(plain.repo), false);
    assert.equal((await mirrorDocs(new SqliteHive(":memory:"), admin, { name: "demo", repo: plain.repo }, { fetch: false })).commit, null);
    const gone = repoWith({ ".xdev-hive/docs.json": JSON.stringify({ docs: [{ file: "docs/gone.md", key: "gone" }] }), "README.md": "# Demo\n" });
    assert.deepEqual((await mirrorDocs(new SqliteHive(":memory:"), admin, { name: "demo", repo: gone.repo }, { fetch: false })).missing, ["docs/gone.md"]);
  });
});
