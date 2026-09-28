import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, transferHive, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const key = (k: string) => (e: unknown) => e instanceof HiveError && e.key === k;
const invalid = (e: unknown) => e instanceof HiveError && e.code === "bad_request";

describe("docs limited to paths", () => {
  it("keeps the paths across saves until they are changed or cleared", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "project/app/web", content: "Use shadcn/ui.", paths: ["apps/web/**", "apps/web/**", "**/*.css"] }, admin);
    assert.deepEqual((await hive.call("docs.get", { key: "project/app/web" }, admin))!.paths, ["apps/web/**", "**/*.css"]);
    await hive.call("docs.save", { key: "project/app/web", content: "Use shadcn/ui and Tailwind." }, admin);
    const [summary] = (await hive.call("docs.list", { project: "app" }, admin)).filter((d) => d.key === "project/app/web");
    assert.deepEqual(summary!.paths, ["apps/web/**", "**/*.css"], "a save without paths keeps them, and the list has them");
    await hive.call("docs.save", { key: "project/app/web", content: "Whole repo now.", paths: [] }, admin);
    assert.deepEqual((await hive.call("docs.get", { key: "project/app/web" }, admin))!.paths, []);
  });

  it("refuses paths on the repo-wide docs and globs that leave the repo", async () => {
    const hive = new SqliteHive(":memory:");
    await assert.rejects(hive.call("docs.save", { key: "project/app/agents", content: "# App", paths: ["apps/**"] }, admin), key("errors.docPathsWholeRepo"));
    await assert.rejects(hive.call("docs.save", { key: "project/app/decisions", content: "# D", paths: ["docs/**"] }, admin), key("errors.docPathsWholeRepo"));
    for (const bad of ["/etc/**", "../other/**", "apps/../../x", "apps web/**", ""]) {
      await assert.rejects(hive.call("docs.save", { key: "project/app/web", content: "x", paths: [bad] }, admin), invalid, bad);
    }
    await hive.call("docs.save", { key: "project/app/web", content: "x", paths: ["src/**/*.{ts,tsx}", "apps/web..old/**", "[abc]/*.md"] }, admin);
  });

  it("moves with the doc between machine and hub", async () => {
    const local = new SqliteHive(":memory:");
    await local.call("docs.save", { key: "project/app/web", content: "Use shadcn/ui.", paths: ["apps/web/**"] }, admin);
    const hub = new SqliteHive(":memory:");
    await transferHive({ backend: local, actor: admin, label: "máy" }, { backend: hub, actor: admin, label: "hub" });
    assert.deepEqual((await hub.call("docs.get", { key: "project/app/web" }, admin))!.paths, ["apps/web/**"]);
  });
});
