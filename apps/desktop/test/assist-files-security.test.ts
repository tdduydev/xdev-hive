import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readRepoFiles } from "#desktop/main/runner/assist.ts";

function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hive-assist-security-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  const outside = path.join(base, "repo-other");
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "OUTSIDE_SENTINEL");
  return { base, repo, outside };
}

test("Docs sources reject escaping file and directory symlinks, directly and through tracked globs", (t) => {
  const { base, repo, outside } = fixture(t);
  fs.writeFileSync(path.join(repo, "ok.md"), "inside");
  fs.symlinkSync(path.join(outside, "secret.md"), path.join(repo, "escape.md"));
  fs.symlinkSync(outside, path.join(repo, "escape-dir"), "dir");
  fs.symlinkSync("ok.md", path.join(repo, "inside.md"));
  fs.symlinkSync("absent.md", path.join(repo, "broken.md"));
  fs.symlinkSync(repo, path.join(base, "repo-alias"), "dir");
  t.mock.method(childProcess, "execFileSync", (command: string, args: string[]) => {
    assert.equal(command, "git");
    assert.deepEqual(args, ["ls-files"]);
    return "broken.md\nescape.md\ninside.md\nok.md\n";
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const got = readRepoFiles(path.join(base, "repo-alias"), ["*.md", "escape-dir/secret.md", path.join(outside, "secret.md")]);
  assert.deepEqual(got.files.map((f) => f.path).sort(), ["inside.md", "ok.md"]);
  assert.ok(got.files.every((f) => f.text === "inside"));
  assert.deepEqual(got.missing.sort(), ["broken.md", "escape.md", "escape-dir/secret.md", path.join(outside, "secret.md")].sort());
});

test("Docs sources bound bytes read even for huge sparse files and cap total text and file count", (t) => {
  const { repo } = fixture(t);
  const huge = path.join(repo, "huge.md");
  fs.writeFileSync(huge, "a".repeat(120_000));
  fs.truncateSync(huge, 1024 ** 3);
  let bytes = 0;
  const original = fs.readSync;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const n = original(...args);
    bytes += n;
    return n;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(readRepoFiles(repo, ["huge.md"]).files[0]?.text.length, 30_000);
  assert.ok(bytes <= 120_000);
  const wanted = Array.from({ length: 20 }, (_, i) => `${i}.md`);
  for (const name of wanted) fs.writeFileSync(path.join(repo, name), "x");
  assert.equal(readRepoFiles(repo, wanted).files.length, 12);
  for (const name of wanted) fs.writeFileSync(path.join(repo, name), "x".repeat(40_000));
  assert.equal(readRepoFiles(repo, wanted).files.reduce((n, f) => n + f.text.length, 0), 120_000);
  for (const name of wanted) fs.writeFileSync(path.join(repo, name), Buffer.alloc(120_000));
  bytes = 0;
  assert.equal(readRepoFiles(repo, wanted).files.length, 0);
  assert.ok(bytes <= 480_000, "rejected binary files also consume the byte budget");
});

test("Docs sources reject a parent swapped to an external symlink during open", (t) => {
  const { repo, outside } = fixture(t);
  const dir = path.join(repo, "sources");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "secret.md"), "inside");
  const original = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    fs.renameSync(dir, path.join(repo, "old-sources"));
    fs.symlinkSync(outside, dir, "dir");
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(readRepoFiles(repo, ["sources/secret.md"]), { files: [], missing: ["sources/secret.md"] });
});

test("Linux checks the opened descriptor when its directory moves outside the repo", { skip: process.platform !== "linux" }, (t) => {
  const { repo, outside } = fixture(t);
  const dir = path.join(repo, "sources");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "page.md"), "moved outside");
  const original = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = original(...args);
    fs.renameSync(dir, path.join(outside, "moved"));
    return fd;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(readRepoFiles(repo, ["sources/page.md"]), { files: [], missing: ["sources/page.md"] });
});
