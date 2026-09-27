import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureClaudeImport, MANAGED_END, MANAGED_START, planProjectSync, stripManaged, type Doc } from "../src/index.ts";

const doc = (key: string, content: string, extra: Partial<Doc> = {}): Doc => ({
  key,
  content,
  scope: key.startsWith("org/") ? "org" : "project",
  project: key.startsWith("project/") ? key.split("/")[1]! : null,
  title: key,
  version: 3,
  includeInAgents: true,
  updatedBy: "duy",
  updatedAt: "2026-09-27T00:00:00Z",
  ...extra,
});

describe("sync", () => {
  it("renders AGENTS.md with the managed block first and the project doc after", () => {
    const files = planProjectSync("app", [
      doc("org/security", "## Security\nNo secrets."),
      doc("org/hidden", "not included", { includeInAgents: false }),
      doc("project/app/agents", "# App\nRun `npm test`."),
      doc("project/app/decisions", "# Decisions"),
    ]);
    assert.deepEqual(files.map((f) => f.path), ["AGENTS.md", "docs/decisions.md"]);
    const agents = files[0]!.content;
    assert.ok(agents.startsWith(MANAGED_START));
    assert.match(agents, /Hive project key: `app`/);
    assert.match(agents, /<!-- org\/security v3 -->\n## Security/);
    assert.doesNotMatch(agents, /not included/);
    assert.ok(agents.indexOf(MANAGED_END) < agents.indexOf("# App"));
    assert.equal(stripManaged(agents), "# App\nRun `npm test`.\n");
  });

  it("keeps CLAUDE.md content and adds the import once", () => {
    assert.equal(ensureClaudeImport(null), "@AGENTS.md\n");
    assert.equal(ensureClaudeImport("Be brief.\n"), "@AGENTS.md\n\nBe brief.\n");
    assert.equal(ensureClaudeImport("@AGENTS.md\n\nBe brief.\n"), "@AGENTS.md\n\nBe brief.\n");
  });
});
