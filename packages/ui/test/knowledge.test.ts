import assert from "node:assert/strict";
import { it } from "node:test";
import type { Proposal, MemoryCleanupProposal } from "@xdev-hive/core";
import { knowledgeHref, knowledgeProposals } from "#ui/lib/knowledge.ts";
import { buildInbox } from "#ui/lib/inbox.ts";
const proposal = (docKey: string) => ({ docKey, status: "pending" } as Proposal);

it("pending tabs show only their own document type and current scope, including team proposals", () => {
  const rows = [proposal("org/skills/review"), proposal("project/app/skills/review"), proposal("project/app/guide"), proposal("project/other/guide"), proposal("project/other/skills/review"), proposal("org/style")];
  const scope = { kind: "project" as const, project: "app" };
  assert.deepEqual(knowledgeProposals(rows, scope, "docs").map((p) => p.docKey), ["project/app/guide", "org/style"]);
  assert.deepEqual(knowledgeProposals(rows, scope, "skills").map((p) => p.docKey), ["org/skills/review", "project/app/skills/review"]);
  assert.equal(knowledgeHref("project/app/skills/review"), "#/skills?skill=project%2Fapp%2Fskills%2Freview");
});
it("Today gathers doc and skill proposals with their proper approval permission", () => {
  const items = buildInbox({ proposals: [proposal("project/app/guide"), proposal("project/app/skills/review")], can: (_, permission) => permission === "docApprove" });
  assert.deepEqual(items.map((p) => p.scope), ["project/app/guide"]);
});

it("Today gathers cleanup suggestions only for a memory approver", () => {
  const cleanup: MemoryCleanupProposal = { id: 1, project: "app", runId: 1, entries: [], kind: "remove", ids: [2], reason: "Obsolete", status: "pending", createdAt: "", reviewer: null, decidedAt: null };
  assert.equal(buildInbox({ cleanup: [cleanup], can: (_, permission) => permission === "memoryApprove" })[0]?.kind, "cleanup");
  assert.equal(buildInbox({ cleanup: [cleanup], can: () => false }).length, 0);
});
