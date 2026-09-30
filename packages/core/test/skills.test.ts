import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, parseDocKey, parseSkill, skillDocKey, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "view" } } };
const key = (k: string) => (e: unknown) => e instanceof HiveError && e.key === k;

const skill = (name: string, description = "Review a pull request the team's way. Use when asked to review.", body = "1. Read the diff.\n2. Run the tests.\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

describe("skill keys and SKILL.md", () => {
  it("reads skill keys next to doc keys", () => {
    assert.deepEqual(parseDocKey("org/skills/review-pr"), { scope: "org", project: null, slug: "review-pr", skill: true });
    assert.deepEqual(parseDocKey("project/app/skills/release"), { scope: "project", project: "app", slug: "release", skill: true });
    assert.deepEqual(parseDocKey("org/skills"), { scope: "org", project: null, slug: "skills", skill: false }, "a doc named skills stays a doc");
    assert.equal(parseDocKey("project/app/agents").skill, false);
    assert.throws(() => parseDocKey("org/skills/a/b"), key("errors.badDocKey"));
    assert.equal(skillDocKey("release", "app"), "project/app/skills/release");
    assert.equal(skillDocKey("review-pr"), "org/skills/review-pr");
  });

  it("reads name and description from the front matter", () => {
    assert.deepEqual(parseSkill(skill("review-pr")), { name: "review-pr", description: "Review a pull request the team's way. Use when asked to review." });
    assert.deepEqual(parseSkill(`---\nname: "db-migrate"\ndescription: 'Write a migration: it''s numbered'\nallowed-tools: Bash(npm test:*)\n---\nSteps`), {
      name: "db-migrate",
      description: "Write a migration: it's numbered",
    });
    assert.deepEqual(parseSkill("---\nname: long\ndescription: >\n  Folded over\n  two lines.\n---\n"), { name: "long", description: "Folded over two lines." });
    assert.equal(parseSkill("---\r\nname: crlf\r\ndescription: Windows line ends\r\n---\r\nbody").name, "crlf");
  });

  it("refuses a SKILL.md agents could not pick", () => {
    assert.throws(() => parseSkill("# Review\nNo front matter"), key("errors.skillFrontMatter"));
    assert.throws(() => parseSkill(skill("Review PR")), key("errors.skillName"));
    assert.throws(() => parseSkill(skill("x".repeat(65))), key("errors.skillName"));
    assert.throws(() => parseSkill("---\nname: empty\n---\nbody"), key("errors.skillDescription"));
    assert.throws(() => parseSkill(skill("long", "d".repeat(1025))), key("errors.skillDescription"));
  });
});

describe("skills in the hive", () => {
  it("saves a skill as a doc that never goes into AGENTS.md", async () => {
    const hive = new SqliteHive(":memory:");
    const doc = await hive.call("docs.save", { key: "org/skills/review-pr", content: skill("review-pr"), includeInAgents: true }, admin);
    assert.equal(doc.includeInAgents, false, "skills go to .claude/skills, not AGENTS.md");
    assert.equal(doc.version, 1);
    await assert.rejects(hive.call("docs.save", { key: "org/skills/review-pr", content: skill("other") }, admin), key("errors.skillNameMismatch"));
    await assert.rejects(hive.call("docs.save", { key: "org/skills/review-pr", content: "just text" }, admin), key("errors.skillFrontMatter"));
    await assert.rejects(hive.call("docs.save", { key: "org/skills/lint", content: skill("lint"), paths: ["src/**"] }, admin), key("errors.skillPaths"));
    await assert.rejects(
      hive.call("docs.save", { key: "org/skills/leak", content: skill("leak", "Deploy", `token ${"glpat-"}${"a".repeat(20)}`) }, admin),
      (e: unknown) => e instanceof HiveError && e.code === "bad_request",
      "secrets are refused in skills as in docs",
    );
  });

  it("takes an agent's skill as a proposal, checked before an admin sees it", async () => {
    const hive = new SqliteHive(":memory:");
    await assert.rejects(
      hive.call("proposals.create", { docKey: "project/app/skills/release", baseVersion: 0, content: skill("deploy"), reason: "new" }, claude),
      key("errors.skillNameMismatch"),
    );
    const p = await hive.call("proposals.create", { docKey: "project/app/skills/release", baseVersion: 0, content: skill("release", "Cut a release."), reason: "we do this weekly" }, claude);
    await hive.call("proposals.approve", { id: p.id }, admin);
    const doc = await hive.call("docs.get", { key: "project/app/skills/release" }, claude);
    assert.equal(doc?.version, 1);
    assert.match(doc?.content ?? "", /name: release/);
  });

  it("lists a project's skills, its own replacing the team's of the same name, within the viewer's projects", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "org/agent-protocol", content: "not a skill" }, admin);
    await hive.call("docs.save", { key: "org/skills/review-pr", content: skill("review-pr", "Team review.") }, admin);
    await hive.call("docs.save", { key: "org/skills/release", content: skill("release", "Team release.") }, admin);
    await hive.call("docs.save", { key: "project/app/skills/release", content: skill("release", "App release: tag, then deploy.") }, admin);
    await hive.call("docs.save", { key: "project/web/skills/storybook", content: skill("storybook", "Web stories.") }, admin);

    const app = await hive.call("skills.list", { project: "app" }, claude);
    assert.deepEqual(
      app.map((s) => [s.name, s.scope, s.description]),
      [
        ["release", "project", "App release: tag, then deploy."],
        ["review-pr", "org", "Team review."],
      ],
    );
    assert.deepEqual(app[0]!.key, "project/app/skills/release");
    const all = await hive.call("skills.list", {}, admin);
    assert.deepEqual(all.map((s) => s.key), ["org/skills/release", "org/skills/review-pr", "project/app/skills/release", "project/web/skills/storybook"]);

    assert.deepEqual((await hive.call("skills.list", {}, lan)).map((s) => s.key), ["org/skills/release", "org/skills/review-pr", "project/app/skills/release"], "web is not hers");
    await assert.rejects(hive.call("skills.list", { project: "web" }, lan), (e: unknown) => e instanceof HiveError && e.code === "not_found", "a project not granted does not show");
  });
});
