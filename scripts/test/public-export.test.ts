import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { exportTree, rewrite } from "../public-export.mjs";

const tmp = mkdtempSync(join(tmpdir(), "public-export-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const config = {
  exclude: ["AGENTS.md", ".claude/", "docs/specs/38-secret.md"],
  docs: ["**/*.md"],
  replace: [
    { from: "nối dự án khách hàng", to: "nối dự án khách hàng" },
    { from: "customer", to: "customer" },
    { from: "win-runner", to: "win-runner" },
    { from: "owner/repo", to: "your-org/repo", files: ["**"] },
  ],
  forbid: ["customer", "win-runner", "example.com", "tdduy"],
  warn: ["hive.example.com"],
};

function fixture(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmp, "repo-"));
  git(repo, "init", "-q");
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), body);
  }
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "fixture");
  return repo;
}

describe("public export", () => {
  it("drops excluded files and folders, keeps the rest of the committed tree", () => {
    const repo = fixture({ "AGENTS.md": "x", ".claude/skills/a.md": "x", "docs/specs/38-secret.md": "x", "docs/specs/39.md": "ok\n", "src/a.ts": "1\n" });
    writeFileSync(join(repo, "untracked.md"), "customer\n");
    const dest = join(tmp, "out-exclude");
    const r = exportTree({ repo, dest, config });
    assert.deepEqual(r.leaks, []);
    assert.equal(r.files, 2);
    for (const f of ["AGENTS.md", ".claude", "docs/specs/38-secret.md", "untracked.md"]) assert.equal(existsSync(join(dest, f)), false, f);
    assert.equal(readFileSync(join(dest, "src/a.ts"), "utf8"), "1\n");
  });

  it("replaces in docs, drops the lines it cannot fix and counts them", () => {
    const { text, dropped } = rewrite("docs/roadmap.md", "a\nnối dự án khách hàng trên win-runner\nrepo ở gitlab.example.com\nb\n", config);
    assert.equal(text, "a\nnối dự án khách hàng trên win-runner\nb\n");
    assert.equal(dropped, 1);
  });

  it("leaves code alone except rules with files, and only reports warn terms there", () => {
    const repo = fixture({ "package.json": '{"repository":"github:owner/repo"}\n', "src/hub.ts": "// e.g. https://hive.example.com\n", "README.md": "hub: hive.example.com\n" });
    const r = exportTree({ repo, dest: join(tmp, "out-warn"), config });
    assert.equal(readFileSync(join(tmp, "out-warn/package.json"), "utf8"), '{"repository":"github:your-org/repo"}\n');
    assert.deepEqual(r.warnings, [{ file: "src/hub.ts", line: 1, term: "hive.example.com" }]);
    assert.deepEqual(r.leaks, []);
  });

  it("blocks forbidden strings left in code with file and line", () => {
    const repo = fixture({ "src/a.ts": "ok\nconst host = 'gitlab.example.com';\n", "test/b.ts": "// customer\n" });
    const r = exportTree({ repo, dest: join(tmp, "out-leak"), config });
    assert.deepEqual(r.leaks, [{ file: "src/a.ts", line: 2, term: "example.com" }, { file: "test/b.ts", line: 1, term: "customer" }]);
  });

  it("refuses a destination that is not empty", () => {
    const repo = fixture({ "a.md": "x\n" });
    const dest = join(tmp, "out-busy");
    mkdirSync(dest);
    writeFileSync(join(dest, "keep"), "x");
    assert.throws(() => exportTree({ repo, dest, config }), /not empty/);
  });
});
