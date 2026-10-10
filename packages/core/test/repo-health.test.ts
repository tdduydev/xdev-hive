import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactUrlCredentials, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const mbp: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const ci: Actor = { name: "runner.ci@ci", role: "agent" };
/** Sees app and web, not api. */
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "view", web: "manage" } } };
const HEAD = "a".repeat(40);

async function hub() {
  const hive = new SqliteHive(":memory:", { now: () => new Date("2026-10-09T08:00:00.000Z") });
  hive.seed("hub");
  for (const p of ["app", "web", "api"]) await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, admin);
  await hive.call("systems.save", { name: "customer-ai", projects: ["app", "web", "api"] }, admin);
  return hive;
}

const beat = (hive: SqliteHive, actor: Actor, input: Record<string, unknown>) =>
  hive.call("machines.heartbeat", { machine: actor.name.split(".")[1]!.split("@")[0]!, instance: "aaaaaaaa", version: "0.155.0", ...input } as never, actor);

describe("system member repo health", () => {
  it("reachable on one machine, unreachable where every check failed, and no machine at all", async () => {
    const hive = await hub();
    await beat(hive, mbp, {
      projects: ["app", "web"],
      repoHealth: [
        { project: "app", status: "ok", checkedAt: "2026-10-09T07:00:00.000Z", head: HEAD, detail: null },
        { project: "web", status: "no_access_or_missing", checkedAt: "2026-10-09T07:00:00.000Z", detail: "remote: The project you were looking for could not be found or you don't have permission to view it." },
      ],
    });
    // An app from before the check: it has the repo but says nothing about it.
    await beat(hive, ci, { projects: ["web"] });
    const health = await hive.call("systems.repoHealth", {}, admin);
    assert.deepEqual(health.map((h) => [h.project, h.state]), [["api", "no_machine"], ["app", "reachable"], ["web", "unreachable"]]);
    const app = health.find((h) => h.project === "app")!;
    assert.deepEqual(app.machines.map((m) => [m.machine, m.status, m.head]), [["duy-mbp", "ok", HEAD]]);
    const web = health.find((h) => h.project === "web")!;
    assert.deepEqual(web.machines.map((m) => [m.machine, m.status]).sort(), [["ci", null], ["duy-mbp", "no_access_or_missing"]]);
    assert.equal(health.find((h) => h.project === "api")!.machines.length, 0);
  });

  it("keeps the last check when a beat carries none, and replaces it when one does", async () => {
    const hive = await hub();
    await beat(hive, mbp, { projects: ["app"], repoHealth: [{ project: "app", status: "network", checkedAt: "2026-10-09T01:00:00.000Z" }] });
    await beat(hive, mbp, { projects: ["app"] });
    let app = (await hive.call("systems.repoHealth", {}, admin)).find((h) => h.project === "app")!;
    assert.equal(app.machines[0]!.status, "network");
    assert.equal(app.state, "unreachable");
    await beat(hive, mbp, { projects: ["app"], repoHealth: [{ project: "app", status: "ok", checkedAt: "2026-10-09T07:00:00.000Z", head: HEAD }] });
    app = (await hive.call("systems.repoHealth", {}, admin)).find((h) => h.project === "app")!;
    assert.deepEqual([app.state, app.machines[0]!.checkedAt], ["reachable", "2026-10-09T07:00:00.000Z"]);
  });

  it("stores no credentials from the detail and nothing for a repo the machine does not report", async () => {
    const hive = await hub();
    await beat(hive, mbp, {
      projects: ["web"],
      repoHealth: [
        { project: "web", status: "no_access", checkedAt: "2026-10-09T07:00:00.000Z", detail: "fatal: Authentication failed for 'https://oauth2:hunter2pass@gitlab.example.com/customer-ai/web.git/'" },
        { project: "app", status: "ok", checkedAt: "2026-10-09T07:00:00.000Z", head: HEAD },
      ],
    });
    const health = await hive.call("systems.repoHealth", {}, admin);
    const web = health.find((h) => h.project === "web")!.machines[0]!;
    assert.equal(web.detail, "fatal: Authentication failed for 'https://gitlab.example.com/customer-ai/web.git/'");
    assert.equal(health.find((h) => h.project === "app")!.state, "no_machine", "app is not among the machine's repos");
    await beat(hive, mbp, { projects: ["web"], repoHealth: [{ project: "web", status: "error", checkedAt: "2026-10-09T07:30:00.000Z", detail: "token glpat-abcdefghijklmnopqrstuvwx leaked" }] });
    const again = (await hive.call("systems.repoHealth", {}, admin)).find((h) => h.project === "web")!.machines[0]!;
    assert.doesNotMatch(again.detail ?? "", /glpat-/);
  });

  it("shows a reader only the members they may see", async () => {
    const hive = await hub();
    await beat(hive, mbp, { projects: ["app", "web", "api"] });
    assert.deepEqual((await hive.call("systems.repoHealth", {}, lan)).map((h) => [h.project, h.state]), [["app", "unchecked"], ["web", "unchecked"]]);
  });

  it("refuses a status it does not know", async () => {
    const hive = await hub();
    await assert.rejects(beat(hive, mbp, { projects: ["app"], repoHealth: [{ project: "app", status: "fine", checkedAt: "2026-10-09T07:00:00.000Z" }] }));
  });
});

describe("redactUrlCredentials", () => {
  it("drops user and password from every URL, and leaves the rest", () => {
    assert.equal(
      redactUrlCredentials("fatal: unable to access 'https://user:p%40ss@host/x.git/' and ssh://git@host:22/y and https://host/z"),
      "fatal: unable to access 'https://host/x.git/' and ssh://host:22/y and https://host/z",
    );
  });
});
