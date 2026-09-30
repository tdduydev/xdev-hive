import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const outsider: Actor = { name: "hoa", role: "member", access: { projects: { web: "view" } } };

describe("what a project's agents get (docs.context)", () => {
  it("describes the AGENTS.md a sync writes, its parts, where docs for some paths go, the files and the memory", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "org/code-style", title: "Quy chuẩn code", content: "- Tên hàm là động từ.\n- Không viết tắt.", includeInAgents: true }, admin);
    await hive.call("docs.save", { key: "org/onboarding", title: "Onboarding", content: "Chỉ trên hub.", includeInAgents: false }, admin);
    await hive.call("docs.save", { key: "project/app/agents", title: "App", content: "# App\nChạy npm test." }, admin);
    await hive.call("docs.save", { key: "project/app/web-ui", title: "Giao diện web", content: "Dùng token màu.", paths: ["apps/web/**"] }, admin);
    await hive.call("docs.save", { key: "project/app/tests", title: "Viết test", content: "Mỗi lỗi một test.", paths: ["**/*.test.ts"] }, admin);
    await hive.call("docs.save", { key: "project/app/skills/deploy", content: "---\nname: deploy\ndescription: Deploy the hub\n---\nChạy update.sh" }, admin);
    await hive.call("memory.write", { project: "app", kind: "gotcha", content: "update.sh cần HIVE_TUNNEL=1" }, admin);
    await hive.call("memory.write", { shared: true, kind: "convention", content: "Commit theo Conventional Commits" }, admin);

    const c = await hive.call("docs.context", { project: "app" }, admin);
    assert.match(c.agentsMd, /Hive project key: `app`/);
    assert.match(c.agentsMd, /Tên hàm là động từ/);
    assert.doesNotMatch(c.agentsMd, /Chỉ trên hub/, "a team doc not meant for AGENTS.md stays out");
    assert.equal(c.lines, c.agentsMd.trimEnd().split("\n").length);
    assert.equal(c.limit, 200);
    assert.deepEqual(c.blocks.map((b) => b.kind), ["shared", "project", "paths", "skills"]);
    assert.deepEqual(c.blocks[0]!.items.map((i) => [i.key, i.version]), [["org/code-style", 1]]);
    assert.deepEqual(c.blocks[1]!.items.map((i) => [i.key, i.lines]), [["project/app/agents", 2]]);
    assert.deepEqual(
      c.paths.map((p) => [p.key, p.file, p.nested]),
      [
        ["project/app/tests", ".claude/rules/xdev-hive/tests.md", false],
        ["project/app/web-ui", "apps/web/AGENTS.md", true],
      ],
    );
    assert.deepEqual(c.files.map((f) => f.path), ["AGENTS.md", ".claude/rules/xdev-hive/tests.md", "apps/web/AGENTS.md", ".claude/skills/deploy/SKILL.md", "CLAUDE.md"]);
    assert.equal(c.files.find((f) => f.path === "apps/web/AGENTS.md")?.block, true, "a nested AGENTS.md keeps what the repo wrote outside Hive's block");
    assert.deepEqual(c.memory, { project: 1, shared: 1, stale: 0, pending: 0 });
    await assert.rejects(hive.call("docs.context", { project: "app" }, outsider), (e) => e instanceof HiveError && e.code === "not_found");
  });
});
