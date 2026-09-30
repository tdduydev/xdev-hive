import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSkill, type SkillSummary } from "@xdev-hive/core";
import { buildSkill, leaderGuide, skillsFor, splitSkill } from "../src/lib/skills.ts";

const summary = (name: string, project: string | null): SkillSummary => ({
  key: project ? `project/${project}/skills/${name}` : `org/skills/${name}`,
  name,
  description: `${name} steps`,
  scope: project ? "project" : "org",
  project,
  version: 1,
  updatedBy: "duy",
  updatedAt: "2026-09-29T08:00:00.000Z",
});

describe("skill form", () => {
  it("reads name, description and body, and keeps the other front matter keys", () => {
    const parts = splitSkill("---\nname: deploy\nallowed-tools: Bash(npm run deploy)\ndescription: >\n  Deploy the app\n  to staging.\n---\n\n1. Build.\n2. Ship.\n");
    assert.deepEqual(parts, { name: "deploy", description: "Deploy the app to staging.", extra: ["allowed-tools: Bash(npm run deploy)"], body: "1. Build.\n2. Ship.\n" });
  });

  it("writes a SKILL.md the hub accepts, quoting a description YAML would misread", () => {
    const content = buildSkill({ name: "review-pr", description: "Review a PR: check tests, # of files\nand risks", extra: ["allowed-tools: Read"], body: "\nSteps.\n\n" });
    assert.equal(content, '---\nname: review-pr\ndescription: "Review a PR: check tests, # of files and risks"\nallowed-tools: Read\n---\n\nSteps.\n');
    assert.deepEqual(parseSkill(content), { name: "review-pr", description: "Review a PR: check tests, # of files and risks" });
    // Round trip: what the form reads back is what it wrote.
    assert.deepEqual(splitSkill(content), { name: "review-pr", description: "Review a PR: check tests, # of files and risks", extra: ["allowed-tools: Read"], body: "Steps.\n" });
    for (const description of ['Say "hi"', "- a list?", "ends with colon:", "back\\slash"]) {
      assert.equal(parseSkill(buildSkill({ name: "x", description, extra: [], body: "b" })).description, description, description);
    }
  });

  it("treats content without front matter as body only", () => {
    assert.deepEqual(splitSkill("Just steps."), { name: "", description: "", extra: [], body: "Just steps." });
  });
});

describe("skills per project", () => {
  const all = [summary("deploy", null), summary("review-pr", null), summary("deploy", "app"), summary("lint", "app"), summary("seo", "site")];

  it("lists every skill for the whole team", () => {
    assert.deepEqual(skillsFor(all, null).map((s) => [s.name, s.project, s.overrides, s.overridden]), [
      ["deploy", null, false, false],
      ["review-pr", null, false, false],
      ["deploy", "app", false, false],
      ["lint", "app", false, false],
      ["seo", "site", false, false],
    ]);
  });

  it("shows what a project's agents get: its own skill replaces the team's of the same name", () => {
    assert.deepEqual(skillsFor(all, "app").map((s) => [s.name, s.project, s.overrides, s.overridden]), [
      ["deploy", "app", true, false],
      ["deploy", null, false, true],
      ["lint", "app", false, false],
      ["review-pr", null, false, false],
    ]);
  });

  it("edits the project's own leader guide, starting from the team's until it has one", () => {
    const team = { content: "---\nname: hive-leader\ndescription: Team guide\nallowed-tools: Read\n---\n\nPropose, never merge.\n" };
    const fromTeam = leaderGuide(null, team);
    assert.deepEqual([fromTeam.from, fromTeam.baseVersion, fromTeam.parts.description, fromTeam.parts.body.trim(), fromTeam.parts.extra], ["team", 0, "Team guide", "Propose, never merge.", ["allowed-tools: Read"]]);
    const own = leaderGuide({ content: "---\nname: hive-leader\ndescription: App guide\n---\n\nAsk before big changes.\n", version: 3 }, team);
    assert.deepEqual([own.from, own.baseVersion, own.parts.description], ["project", 3, "App guide"]);
    const none = leaderGuide(null, null);
    assert.deepEqual([none.from, none.parts.name, none.parts.body], ["none", "hive-leader", ""]);
    // Whatever the source said, the saved guide is the leader's.
    assert.equal(parseSkill(buildSkill({ ...leaderGuide({ content: "no front matter", version: 1 }, null).parts, description: "x" })).name, "hive-leader");
  });
});
