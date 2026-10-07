import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { DEFAULT_MODEL_ROUTER, PREFER_KINDS, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };

it("saves dispatch choices and model allowlists for all providers together", async () => {
  const hive = new SqliteHive(":memory:");
  try {
    await hive.call("tasks.create", { project: "app", id: "T-1", title: "Provider integration" }, admin);
    const kinds = [...PREFER_KINDS];
    const view = await hive.call("sdlc.setProject", { project: "app", settings: { gates: {}, allowedAgentKinds: kinds } }, admin);
    assert.deepEqual(view.projects.app?.allowedAgentKinds, kinds);
    const models = Object.fromEntries(kinds.map((kind) => [kind, [kind === "opencode" ? "provider/model" : kind === "kilo" ? "kilo/kilo-auto/free" : "test-model"]]));
    const policy = await hive.call("agentPolicy.set", { project: "app", policy: { models } }, admin);
    assert.deepEqual(policy.projects.app?.models, models);
    await assert.rejects(hive.call("sdlc.setProject", { project: "app", settings: { gates: {}, allowedAgentKinds: ["custom"] } } as never, admin));
  } finally { hive.close(); }
});

it("upgrades the review base without replacing saved Copilot choices or older migrations", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-provider-upgrade-"));
  const file = path.join(dir, "hub.db");
  try {
    const old = new SqliteHive(file, { migrateTo: migrationIndex("'kilo-cli'") });
    const saved = structuredClone(DEFAULT_MODEL_ROUTER);
    for (const tier of Object.values(saved.tiers)) {
      for (const kind of ["gemini", "vibe", "opencode", "kilo"] as const) delete (tier as Partial<typeof tier>)[kind];
      tier.copilot = { model: "pinned-copilot", effort: "low" };
    }
    old.db.prepare("INSERT INTO settings(key, value) VALUES ('modelRouter', ?)").run(JSON.stringify(saved));
    old.db.prepare("INSERT INTO auto_release_pauses(project) VALUES ('app')").run();
    old.close();
    const upgraded = new SqliteHive(file);
    try {
      const config = await upgraded.call("modelRouter.get", {}, admin);
      for (const [name, tier] of Object.entries(config.tiers)) {
        assert.deepEqual(tier.copilot, { model: "pinned-copilot", effort: "low" });
        for (const kind of ["gemini", "vibe", "opencode", "kilo"] as const)
          assert.deepEqual(tier[kind], DEFAULT_MODEL_ROUTER.tiers[name as keyof typeof config.tiers][kind]);
      }
      assert.ok(upgraded.db.prepare("SELECT project FROM auto_release_pauses WHERE project = 'app'").get());
      assert.ok(upgraded.db.prepare("SELECT id FROM tools WHERE id = 'kilo-cli'").get());
    } finally { upgraded.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
