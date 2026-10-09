import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Artifact } from "@xdev-hive/core";
import { artifactParts, textMatches } from "#ui/lib/artifacts.ts";

const artifact = (id: number, name: string): Artifact => ({ id, name, project: "app", taskId: "APP-1", runId: `R-${id}`, machineId: "runner.one", type: "text/markdown", size: 4, sha256: "sha", profileId: null, uploadedBy: "runner.one", source: null, createdAt: `2026-10-07T00:00:0${id}.000Z`, version: 1, versionNote: "", pinned: false });

describe("artifact references", () => {
  it("links full paths and bare names with punctuation, respecting filename boundaries", () => {
    const a = artifact(1, "reports/audit.md");
    const parts = artifactParts("`reports/audit.md`, audit.md. other-audit.md audit.md.bak", [a]);
    assert.deepEqual(parts.filter((p) => p.artifact).map((p) => p.text), ["reports/audit.md", "audit.md"]);
    assert.equal(parts.map((p) => p.text).join(""), "`reports/audit.md`, audit.md. other-audit.md audit.md.bak");
  });
  it("links the worktree artifact path", () => {
    const a = artifact(1, "reports/audit.md");
    assert.equal(artifactParts(".xdev-hive/artifacts/reports/audit.md", [a])[0]?.artifact, a);
  });
  it("opens the newest duplicate name and does not link files outside the supplied context", () => {
    const old = artifact(1, "audit.md"); const latest = artifact(2, "audit.md");
    assert.equal(artifactParts("audit.md other.md", [old, latest])[0]?.artifact?.id, 2);
    assert.deepEqual(artifactParts("audit.md", []), [{ text: "audit.md" }]);
  });
  it("handles regex characters in names and in literal text searches", () => {
    const a = artifact(1, "result(1).json");
    assert.equal(artifactParts("result(1).json", [a])[0]?.artifact, a);
    assert.deepEqual(textMatches("A.* a.*", "a.*"), ["", "A.*", " ", "a.*", ""]);
    assert.deepEqual(textMatches("<script> hi", ""), ["<script> hi"]);
  });
});
