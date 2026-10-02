import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveGates, EMPTY_SDLC_POLICY, HiveError, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Roadmap 34a: lifecycle gates. The hub admin sets how far each gate may go; a project picks within it.

const admin: Actor = { name: "duy", role: "admin" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "contribute" } } };
const outsider: Actor = { name: "khoa", role: "member", access: { projects: { site: "manage" } } };

async function hub() {
  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { id: "T-1", project: "app", title: "One" }, admin);
  await hive.call("tasks.create", { id: "S-1", project: "site", title: "Landing" }, admin);
  return hive;
}

async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  assert.fail("expected the call to fail");
}

describe("lifecycle gates (roadmap 34a)", () => {
  it("leaves every gate to a person until a project opens one, and never past the hub's ceiling", () => {
    assert.deepEqual(effectiveGates(EMPTY_SDLC_POLICY, "app"), { spec: "human", plan: "human", tasks: "human", dispatch: "human", review: "human", fix: "human", merge: "human" });
    const policy = { ...EMPTY_SDLC_POLICY, ceiling: { merge: "ai" as const, fix: "human" as const }, projects: { app: { gates: { spec: "auto" as const, merge: "auto" as const, fix: "auto" as const } } } };
    const app = effectiveGates(policy, "app");
    assert.deepEqual([app.spec, app.merge, app.fix, app.plan], ["auto", "ai", "human", "human"]);
  });

  it("lets a project manager open gates within the ceiling, and only a hub admin move the ceiling", async () => {
    const hive = await hub();
    const before = await hive.call("sdlc.get", {}, admin);
    assert.equal(before.ceiling.merge, "auto", "the hub sets no limit until its admin does");
    assert.deepEqual(before.projects.app?.effective.spec, "human");

    const set = await hive.call("sdlc.setProject", { project: "app", settings: { gates: { spec: "ai", merge: "auto", plan: "human" }, maxFixRounds: 3, maxParallel: 2 } }, lead);
    assert.deepEqual(set.projects.app?.gates, { spec: "ai", merge: "auto" }, "human is the default: not stored");
    assert.deepEqual([set.projects.app?.maxFixRounds, set.projects.app?.maxParallel], [3, 2]);
    assert.equal(await refusal(hive.call("sdlc.setProject", { project: "app", settings: { gates: { spec: "ai" } } }, dev)), "errors.need.projectSettings");
    assert.equal(await refusal(hive.call("sdlc.setCeiling", { ceiling: { merge: "human" } }, lead)), "errors.roleTooLow");
    const projectAdmin: Actor = { name: "hoa", role: "admin", access: { projects: { app: "manage" } } };
    assert.equal(await refusal(hive.call("sdlc.setCeiling", { ceiling: { merge: "human" } }, projectAdmin)), "errors.hubAdminOnly", "an admin of some projects only does not bind the others");

    const capped = await hive.call("sdlc.setCeiling", { ceiling: { merge: "ai", review: "human" } }, admin);
    assert.deepEqual([capped.ceiling.merge, capped.ceiling.review, capped.ceiling.spec], ["ai", "human", "auto"]);
    assert.equal(capped.projects.app?.effective.merge, "ai", "lowering the ceiling holds the project down at once");
    assert.equal(capped.projects.app?.gates.merge, "auto", "the project's own choice is kept for when the ceiling rises");
    assert.equal(await refusal(hive.call("sdlc.setProject", { project: "app", settings: { gates: { review: "ai" } } }, lead)), "errors.gateOverCeiling");

    const cleared = await hive.call("sdlc.setProject", { project: "app", settings: null }, lead);
    assert.deepEqual(cleared.projects.app?.gates, {});

    const audit = await hive.call("admin.audit", { action: "sdlc.setCeiling" }, admin);
    assert.equal(audit[0]?.detailKey, "audit.sdlcCeiling");
  });

  it("shows a project's gates only to readers of it", async () => {
    const hive = await hub();
    await hive.call("sdlc.setProject", { project: "app", settings: { gates: { spec: "ai" } } }, admin);
    const seen = await hive.call("sdlc.get", {}, outsider);
    assert.deepEqual(Object.keys(seen.projects), ["site"]);
    assert.deepEqual(await hive.call("sdlc.gates", {}, outsider), []);
  });
});
