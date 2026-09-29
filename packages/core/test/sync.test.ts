import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureClaudeImport, globDir, MANAGED_END, MANAGED_START, planProjectSync, projectSkills, stripManaged, withManagedBlock, type Doc } from "../src/index.ts";

const doc = (key: string, content: string, extra: Partial<Doc> = {}): Doc => ({
  key,
  content,
  scope: key.startsWith("org/") ? "org" : "project",
  project: key.startsWith("project/") ? key.split("/")[1]! : null,
  title: key,
  version: 3,
  includeInAgents: true,
  paths: [],
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

describe("docs for some paths", () => {
  it("finds the folder of a glob", () => {
    assert.equal(globDir("apps/web/**"), "apps/web");
    assert.equal(globDir("apps/web/src/**/*.tsx"), "apps/web/src");
    assert.equal(globDir("packages/*/src/**"), "packages");
    assert.equal(globDir("**/*.test.ts"), "");
    assert.equal(globDir("*.md"), "");
    assert.equal(globDir("src/main.ts"), "src");
    assert.equal(globDir("apps/{web,api}/**"), "apps");
  });

  it("puts them in nested AGENTS.md or Claude Code rules, and only lists them in AGENTS.md", () => {
    const files = planProjectSync("app", [
      doc("org/security", "## Security\nNo secrets."),
      doc("org/testing", "Use node:test.", { paths: ["**/*.test.ts"] }),
      doc("org/private", "not for repos", { paths: ["docs/**"], includeInAgents: false }),
      doc("project/app/agents", "# App"),
      doc("project/app/web", "Use shadcn/ui.", { title: "Web", paths: ["apps/web/**", "apps/web-admin/**", "**/*.css"] }),
      doc("project/app/api", "REST only.", { title: "API", paths: ["apps/api/**"] }),
      doc("project/other/web", "not this project", { paths: ["apps/web/**"] }),
    ]);
    assert.deepEqual(
      files.map((f) => [f.path, f.block ?? false]),
      [
        ["AGENTS.md", false],
        [".claude/rules/xdev-hive/org-testing.md", false],
        [".claude/rules/xdev-hive/web.md", false],
        ["apps/api/AGENTS.md", true],
        ["apps/web-admin/AGENTS.md", true],
        ["apps/web/AGENTS.md", true],
      ],
    );
    const [agents, testing, webRule, api, webAdmin, web] = files.map((f) => f.content);
    assert.match(agents!, /## Security/);
    assert.doesNotMatch(agents!, /Use node:test|Use shadcn|REST only|not for repos|not this project/, "listed, not included");
    assert.match(agents!, /- `\*\*\/\*\.test\.ts`: `\.claude\/rules\/xdev-hive\/org-testing\.md` \(org\/testing\)/);
    assert.match(agents!, /- `apps\/web\/\*\*`: `apps\/web\/AGENTS\.md` \(Web\)/);
    assert.ok(agents!.indexOf("Docs for some paths") < agents!.indexOf(MANAGED_END));
    assert.equal(testing, `---\npaths:\n  - "**/*.test.ts"\n---\n${MANAGED_START}\n<!-- org/testing v3 -->\n> Applies to \`**/*.test.ts\`.\n\nUse node:test.\n${MANAGED_END}\n`);
    assert.match(webRule!, /paths:\n {2}- "\*\*\/\*\.css"\n---/);
    assert.equal(api, `${MANAGED_START}\n<!-- project/app/api v3 -->\n> Applies to \`apps/api/**\`.\n\nREST only.\n\n${MANAGED_END}`);
    assert.match(web!, /Applies to `apps\/web\/\*\*`\.\n\nUse shadcn\/ui\./);
    assert.match(webAdmin!, /Applies to `apps\/web-admin\/\*\*`\./);
  });

  it("keeps what a nested AGENTS.md has outside the block", () => {
    const block = `${MANAGED_START}\nHive part\n${MANAGED_END}`;
    assert.equal(withManagedBlock(null, block), `${block}\n`);
    assert.equal(withManagedBlock("# Web\nOwn notes.\n", block), `${block}\n\n# Web\nOwn notes.\n`);
    assert.equal(withManagedBlock(`${MANAGED_START}\nold\n${MANAGED_END}\n\n# Web\n`, block), `${block}\n\n# Web\n`);
  });
});

describe("skills in the repo", () => {
  const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`;

  it("writes each skill as a SKILL.md with its front matter first, and lists them in AGENTS.md", () => {
    const files = planProjectSync("app", [
      doc("project/app/agents", "# App"),
      // includeInAgents is forced off for skills by the hive; even set, a skill is never pasted into AGENTS.md.
      doc("org/skills/review-pr", skill("review-pr", "Team review.")),
      doc("org/skills/release", skill("release", "Team release.")),
      doc("project/app/skills/release", skill("release", "App release.")),
      doc("project/web/skills/storybook", skill("storybook", "Web only.")),
    ]);
    assert.deepEqual(files.map((f) => f.path), ["AGENTS.md", ".claude/skills/release/SKILL.md", ".claude/skills/review-pr/SKILL.md"]);
    const release = files[1]!.content;
    assert.ok(release.startsWith(`---\nname: release\ndescription: App release.\n---\n${MANAGED_START}\n`), "the project's own replaces the team's");
    assert.match(release, /<!-- project\/app\/skills\/release v3 -->\n\nSteps for release\.\n<!-- xdev-hive:end -->\n$/);
    const agents = files[0]!.content;
    assert.match(agents, /## Skills\n\n[^\n]*`skill_get`[^\n]*\n\n- `release`: App release\.\n- `review-pr`: Team review\.\n/);
    assert.doesNotMatch(agents, /Steps for/, "the steps stay in the skill files");
    assert.ok(agents.indexOf("## Skills") < agents.indexOf(MANAGED_END), "inside the managed block");
  });

  it("picks the skills of one project", () => {
    const docs = [doc("org/skills/a", skill("a", "x")), doc("project/app/skills/b", skill("b", "y")), doc("project/web/skills/c", skill("c", "z")), doc("org/security", "not a skill")];
    assert.deepEqual(projectSkills("app", docs).map((d) => d.key), ["org/skills/a", "project/app/skills/b"]);
    assert.equal(planProjectSync("web", [doc("project/web/agents", "# Web")])[0]!.content.includes("## Skills"), false, "no skills, no section");
  });
});
