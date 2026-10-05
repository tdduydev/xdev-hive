// Deleting a project (roadmap 47) has to reach the hub's own tables too: the accounts' grants and the webhooks' project
// filters live in the same database as the hive, in tables those stores create after the migrations have run.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { UserStore } from "#web/users.ts";
import { WebhookStore } from "#web/webhooks.ts";

const admin: Actor = { name: "duy", role: "admin" };

async function hub() {
  const hive = new SqliteHive(":memory:", {
    now: () => new Date("2026-10-05T08:00:00.000Z"),
    backup: async () => ({ file: "/backups/hub-2026-10-05T08-00-00-000Z.db" }),
  });
  hive.seed("hub");
  const users = new UserStore(hive.db);
  const webhooks = new WebhookStore(hive.db);
  for (const p of ["old", "keep"]) await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, admin);
  const lan = users.create({ username: "lan", admin: false }).user;
  users.setGrants(lan.id, { old: "lead", keep: "view" });
  webhooks.save({ name: "team", kind: "slack", url: "https://hooks.slack.test/abc", events: ["run.failed"], projects: ["old", "keep"], locale: "vi", enabled: true });
  return { hive, users, webhooks, lan };
}

describe("deleting a project clears the hub's own tables (roadmap 47)", () => {
  it("takes the project out of the accounts' grants and the webhooks' filters", async () => {
    const { hive, users, webhooks, lan } = await hub();
    await hive.call("projects.archive", { project: "old" }, admin);
    const deleted = await hive.call("projects.delete", { project: "old", confirm: "old" }, admin);
    // hub_grants is found by the schema scan, like any other table with a project column.
    assert.ok(deleted.rows.hub_grants, `hub_grants was not swept: ${JSON.stringify(deleted.rows)}`);
    assert.deepEqual(users.get(lan.id)?.grants, { keep: "viewer" });
    assert.deepEqual(webhooks.list()[0]!.projects, ["keep"], "the webhook keeps the project it still has");
  });

  it("refuses to delete a project nobody archived, whatever the hub's stores hold", async () => {
    const { hive, users, lan } = await hub();
    await assert.rejects(
      hive.call("projects.delete", { project: "old", confirm: "old" }, admin),
      (e: unknown) => e instanceof HiveError && e.key === "errors.projectNotArchived",
    );
    assert.deepEqual(users.get(lan.id)?.grants, { old: "lead", keep: "viewer" });
  });
});
