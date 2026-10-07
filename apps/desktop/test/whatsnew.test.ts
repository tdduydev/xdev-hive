import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateWhatsNew, readWhatsNewOverride } from "#desktop/scripts/whatsnew.mjs";

test("release notes compare roadmap IDs across two tags and include merged fixes", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-whatsnew-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" } });
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    mkdirSync(path.join(dir, "docs"));
    const roadmap = path.join(dir, "docs/roadmap.md");
    const before = "## Tính năng\n- **59. flow-speed**: nhóm\n  - [ ] **59h. release-notes**: soạn tự động\n  - [x] **59g. batch-tool**: đã xong\n  - [ ] **59i. deploy-log-check**: còn chờ\n";
    writeFileSync(roadmap, before);
    git("add", "."); git("commit", "-qm", "feat: baseline"); git("tag", "v0.1.0");
    const baseBranch = git("branch", "--show-current").trim();
    git("checkout", "-qb", "fix-branch");
    git("commit", "--allow-empty", "-qm", "fix(updater): chờ run xong");
    git("checkout", "-q", baseBranch);
    git("merge", "--no-ff", "-qm", "Merge fix branch", "fix-branch");
    writeFileSync(roadmap, before.replace("[ ] **59h", "[x] **59h").replace("đã xong", "đã xong, sửa chữ"));
    git("add", "."); git("commit", "-qm", "feat: notes"); git("tag", "v0.2.0");
    const notes = generateWhatsNew(dir, "v0.2.0");
    assert.match(notes, /## Có gì mới\n\n### 59\. flow-speed/);
    assert.match(notes, /59h\. release-notes/);
    assert.match(notes, /fix\(updater\): chờ run xong/);
    assert.doesNotMatch(notes, /59g|59i|Merge fix|feat:/);
    assert.equal(generateWhatsNew(dir, "v0.3.0"), "## Có gì mới\n\n- Không có thay đổi mới.\n");
    git("tag", "-d", "v0.1.0", "v0.2.0");
    assert.match(generateWhatsNew(dir, "v0.1.0"), /59g\. batch-tool/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("custom notes preserve supplied Markdown and validate the option", () => {
  assert.equal(readWhatsNewOverride([], () => ""), undefined);
  assert.equal(readWhatsNewOverride(["--whatsnew", "draft.md"], (file) => {
    assert.equal(file, "draft.md"); return "## Có gì mới\n\n- Nội dung biên tập.\n";
  }), "## Có gì mới\n\n- Nội dung biên tập.\n");
  assert.throws(() => readWhatsNewOverride(["--whatsnew"], () => ""), /file path/);
  assert.throws(() => readWhatsNewOverride(["--whatsnew", "--dry"], () => ""), /file path/);
  assert.throws(() => readWhatsNewOverride(["--whatsnew", "empty.md"], () => " \n"), /empty/);
});
