import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reviewFiles, diffFixInstructions, reviewRisks } from "#ui/lib/diff-review.ts";
import { parsePatch } from "#ui/lib/runlog.ts";

describe("hunk review notes", () => {
  const files = reviewFiles(parsePatch("diff --git a/a file.ts b/a file.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -8,2 +8,2 @@\n same\n-safe\n+delete\ndiff --git a/icon.png b/icon.png\nBinary files differ"));
  it("preserves paths, context and original hunk headers for the Diff component", () => {
    assert.equal(files[0]!.path, "a file.ts");
    assert.equal(files[0]!.hunks[1]!.before, "same\nsafe\n");
    assert.equal(files[0]!.hunks[1]!.after, "same\ndelete\n");
    assert.equal(files[1]!.binary, true);
    assert.equal(files[1]!.hunks.length, 0);
  });
  it("keeps rule flags as a floor when the model understates risk", () => {
    const db = reviewFiles(parsePatch("diff --git a/db.ts b/db.ts\n@@ -1 +1 @@\n-old\n+DROP TABLE users;"));
    assert.equal(reviewRisks(db, { groups: [], risks: [{ path: "db.ts", hunk: 0, kind: "deletion", level: "low", explanation: "AI note" }] })[0]!.level, "high");
  });
  it("collects notes with file/hunk coordinates and ignores blank or invalid references", () => {
    assert.equal(diffFixInstructions(files, { "0:1": " Keep data. ", "0:0": "Fix name.", "1:0": "Binary", "9:9": "gone", "bad": "bad", "0:9": " " }), "a file.ts\n@@ -8,2 +8,2 @@\nKeep data.\n\na file.ts\n@@ -1 +1 @@\nFix name.");
  });
});
