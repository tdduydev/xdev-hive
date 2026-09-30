import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLog, parsePatch } from "../src/lib/runlog.ts";

describe("run log and diff", () => {
  it("labels the runner's readable log", () => {
    const lines = parseLog(
      ["$ claude -p", "# cwd /w", "", "## Prompt", "Do T-1", "", "## Output", "▶ Bash: npm test", "  ✓ ok 1 - adds (+1 lines)", "  ✗ not ok 2", "Working…", "", "# exit 1", ""].join("\n"),
    );
    assert.deepEqual(
      lines.map((l) => [l.level, l.text]),
      [
        ["meta", "$ claude -p"],
        ["meta", "# cwd /w"],
        ["section", "Prompt"],
        ["agent", "Do T-1"],
        ["agent", ""],
        ["section", "Output"],
        ["tool", "Bash: npm test"],
        ["ok", "ok 1 - adds (+1 lines)"],
        ["error", "not ok 2"],
        ["agent", "Working…"],
        ["agent", ""],
        ["meta", "# exit 1"],
      ],
    );
    assert.equal(lines[6]!.section, "Output");
  });

  it("counts the lines each file of a git diff adds and removes", () => {
    const files = parsePatch(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,3 @@",
        " keep",
        "-old",
        "+new",
        "+more",
        "diff --git a/img.png b/img.png",
        "Binary files a/img.png and b/img.png differ",
      ].join("\n"),
    );
    assert.equal(files.length, 2);
    assert.deepEqual([files[0]!.path, files[0]!.adds, files[0]!.dels], ["src/a.ts", 2, 1]);
    assert.deepEqual(files[0]!.lines.map((l) => l.kind), ["hunk", "ctx", "del", "add", "add"]);
    assert.ok(files[1]!.binary);
  });
});
