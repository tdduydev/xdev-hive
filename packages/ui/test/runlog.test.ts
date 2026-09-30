import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLog, parsePatch, runSteps } from "../src/lib/runlog.ts";

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

import { insertMd, parsePaths } from "../src/lib/docdraft.ts";

describe("doc editor helpers", () => {
  it("wraps the selection, or starts the line, for the Markdown toolbar", () => {
    assert.deepEqual(insertMd("a word b", 2, 6, "**", "**"), { text: "a **word** b", start: 4, end: 8 });
    assert.deepEqual(insertMd("one\ntwo", 5, 5, "## ", "", true), { text: "one\n## two", start: 8, end: 8 });
    assert.deepEqual(insertMd("", 0, 0, "- ", "", true), { text: "- ", start: 2, end: 2 });
  });

  it("reads globs as typed", () => {
    assert.deepEqual(parsePaths("apps/web/**, **/*.test.ts\napps/web/**"), ["apps/web/**", "**/*.test.ts"]);
  });
});

describe("run steps and line times (roadmap 22l)", () => {
  const log = [
    "## Output",
    "2026-09-30T08:00:01Z\t▶ memory_search {\"query\":\"deploy\"}",
    "2026-09-30T08:00:04Z\t▶ Read apps/web/src/app.ts",
    "2026-09-30T08:01:10Z\t▶ Edit apps/web/src/app.ts",
    "2026-09-30T08:01:30Z\t▶ Read apps/web/test/app.test.ts",
    "2026-09-30T08:02:00Z\t▶ Bash: npm test -w @xdev-hive/web",
    "2026-09-30T08:02:09Z\t  ✓ 41 pass",
    "2026-09-30T08:02:10Z\tDone.",
  ].join("\n");

  it("reads the time before each line, and leaves unstamped lines without one", () => {
    const lines = parseLog(log);
    assert.deepEqual(lines.slice(0, 3).map((l) => [l.level, l.at, l.text]), [
      ["section", null, "Output"],
      ["tool", "2026-09-30T08:00:01Z", 'memory_search {"query":"deploy"}'],
      ["tool", "2026-09-30T08:00:04Z", "Read apps/web/src/app.ts"],
    ]);
    assert.equal(lines.at(-1)!.text, "Done.");
  });

  it("shows how far the run got: reading again after editing is still writing code", () => {
    const running = runSteps("implement", parseLog(log), "running");
    assert.deepEqual(running.map((s) => [s.id, s.state]), [
      ["read", "done"],
      ["code", "done"],
      ["test", "current"],
      ["deliver", "todo"],
    ]);
    assert.equal(running[0]!.at, "2026-09-30T08:00:01Z");
    assert.equal(running[2]!.at, "2026-09-30T08:02:00Z");
    assert.deepEqual(runSteps("implement", parseLog(log), "failed").map((s) => s.state), ["done", "done", "failed", "todo"]);
    assert.ok(runSteps("implement", parseLog(log), "succeeded").every((s) => s.state === "done"));
    assert.ok(runSteps("implement", [], "queued").every((s) => s.state === "todo"));
    assert.deepEqual(runSteps("implement", [], "running").map((s) => s.state), ["current", "todo", "todo", "todo"], "a run that has not called a tool yet is reading");
    const review = runSteps("review", parseLog("2026-09-30T08:00:00Z\t▶ Bash: git diff main...ai/T-1\n2026-09-30T08:00:05Z\t▶ Grep: TODO"), "running");
    assert.deepEqual(review.map((s) => [s.id, s.state]), [
      ["readDiff", "done"],
      ["check", "current"],
      ["comment", "todo"],
    ]);
  });
});
