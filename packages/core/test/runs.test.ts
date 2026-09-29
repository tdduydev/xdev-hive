import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, type Actor } from "../src/index.ts";
import { SqliteHive } from "../src/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machineA: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const machineB: Actor = { name: "runner.lan-mbp@lan-mbp", role: "agent" };
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "view" } } };

const run = (over: Record<string, unknown> = {}) => ({
  runId: "R-abc123",
  project: "app",
  taskId: "T-1",
  taskTitle: "Login page",
  role: "implement" as const,
  status: "running" as const,
  profileId: "claude-1",
  activity: "Bash: mvn -B verify",
  log: "▶ Bash: mvn -B verify\n  ✓ BUILD SUCCESS",
  createdAt: "2026-09-29T04:00:00.000Z",
  startedAt: "2026-09-29T04:00:01.000Z",
  ...over,
});

describe("run records", () => {
  it("keeps what a machine pushes, newest first, the log only for one run", async () => {
    const hive = new SqliteHive(":memory:");
    assert.deepEqual(await hive.call("runs.push", { machine: "duy-mbp", runs: [run()] }, machineA), { stored: 1 });
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run({ runId: "R-def456", taskId: "T-2", taskTitle: "Refresh", status: "queued", activity: null, log: "", createdAt: "2026-09-29T03:50:00.000Z" })] }, machineA);
    // The same run again: an update, not a second row.
    await hive.call(
      "runs.push",
      { machine: "duy-mbp", runs: [run({ status: "succeeded", activity: null, summary: "Done.", commits: 2, mrUrl: "https://github.com/duy/app/pull/3", costUsd: 0.4, finishedAt: "2026-09-29T04:09:00.000Z" })] },
      machineA,
    );
    const list = await hive.call("runs.list", { project: "app" }, admin);
    assert.deepEqual(list.map((r) => [r.runId, r.status]), [["R-abc123", "succeeded"], ["R-def456", "queued"]]);
    assert.equal(list[0]!.log, undefined, "no log in the list");
    assert.deepEqual([list[0]!.machine, list[0]!.machineId, list[0]!.commits, list[0]!.mrUrl], ["duy-mbp", machineA.name, 2, "https://github.com/duy/app/pull/3"]);
    const one = await hive.call("runs.get", { machineId: machineA.name, runId: "R-abc123" }, admin);
    assert.match(one?.log ?? "", /BUILD SUCCESS/);
    assert.equal(one?.summary, "Done.");
  });

  it("hides secret-looking lines and hidden characters, whatever the machine sent", async () => {
    const hive = new SqliteHive(":memory:");
    const token = `glpat-${"x".repeat(24)}`;
    await hive.call(
      "runs.push",
      { machine: "duy-mbp", runs: [run({ log: `ok\nexport GITLAB_TOKEN=${token}\nbye${String.fromCodePoint(0x202e)}`, summary: `used ${token}` })] },
      machineA,
    );
    const one = (await hive.call("runs.get", { machineId: machineA.name, runId: "R-abc123" }, admin))!;
    assert.equal(one.log, "ok\n(line hidden: it looked like a GitLab token)\nbye");
    assert.equal(one.summary, "(line hidden: it looked like a GitLab token)");
  });

  it("keeps two machines' runs of the same id apart, and shows each person only their projects", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run()] }, machineA);
    await hive.call("runs.push", { machine: "lan-mbp", runs: [run({ project: "billing", taskTitle: "Invoices" })] }, machineB);
    assert.equal((await hive.call("runs.list", {}, admin)).length, 2);
    assert.deepEqual((await hive.call("runs.list", {}, lan)).map((r) => r.project), ["app"]);
    assert.equal(await hive.call("runs.get", { machineId: machineB.name, runId: "R-abc123" }, lan), null, "billing is not hers");
    await assert.rejects(hive.call("runs.list", { project: "billing" }, lan), (e: unknown) => e instanceof HiveError && e.code === "not_found");
    await assert.rejects(
      hive.call("runs.push", { machine: "duy-mbp", runs: [run()] }, { ...lan, role: "viewer" }),
      (e: unknown) => e instanceof HiveError && e.code === "forbidden",
    );
  });

  it("forgets runs 30 days after their last update", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run()] }, machineA);
    hive.db.prepare("UPDATE run_records SET updated_at = ?").run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run({ runId: "R-new001" })] }, machineA);
    assert.deepEqual((await hive.call("runs.list", {}, admin)).map((r) => r.runId), ["R-new001"]);
  });
});
