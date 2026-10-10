import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, isSafeCloneUrl, isSafeRepoPath, projectCommandStatus, projectOrderSchema, type Actor } from "#core/index.ts";
import { SqliteHive, migrationIndex } from "#core/node.ts";

const admin: Actor = { name: "admin", role: "admin" };
const owner: Actor = { name: "owner", account: "owner", role: "viewer", access: { projects: { demo: "viewer" } } };
const machine: Actor = { name: "runner.hc@owner", account: "owner", role: "agent" };
const isError = (key: string) => (err: unknown) => err instanceof HiveError && err.key === key;

async function hub() {
  const hive = new SqliteHive(":memory:");
  // Known projects: a task makes a project exist on the hub.
  for (const [i, project] of ["demo", "member-a", "gone"].entries()) await hive.call("tasks.create", { project, id: `T-${i + 1}`, title: "x" }, admin);
  const beat = (input: Record<string, unknown> = {}) => hive.call("machines.heartbeat", {
    machine: "hc", instance: "aaaaaaaa", projects: ["demo", "gone"],
    repos: [{ project: "demo", path: "/work/demo" }, { project: "gone", path: "/work/gone" }], ...input,
  }, machine);
  return { hive, beat };
}

describe("machine project commands (ADM-machine-projects)", () => {
  it("queues an add for the machine's next heartbeat and keeps its result", async () => {
    const { hive, beat } = await hub();
    try {
      await beat();
      const command = await hive.call("machines.projectCommand", { machine: "hc", op: "add", project: "member-a", repo: "/work/member-a", cloneUrl: "git@gitlab.example.com:group/member-a.git", gitlabProject: "group/member-a" }, admin);
      assert.equal(command.ok, null);
      const reply = await beat();
      assert.deepEqual(reply.projectCommands?.map((c) => [c.id, c.op, c.project, c.repo]), [[command.id, "add", "member-a", "/work/member-a"]]);
      assert.equal(projectCommandStatus(command), "pending");
      // A machine cannot answer for another one's command.
      await hive.call("machines.heartbeat", { machine: "other", instance: "bbbbbbbb", projectResults: [{ id: command.id, ok: true, error: null }] }, { name: "runner.other@owner", role: "agent" });
      assert.equal((await beat()).projectCommands?.length, 1);
      const done = await beat({ projectResults: [{ id: command.id, ok: false, error: "not a git repository" }] });
      assert.equal(done.projectCommands?.length, 0);
      const view = (await hive.call("machines.projects", {}, admin)).find((m) => m.machineId === machine.name)!;
      assert.equal(view.supported, true);
      assert.equal(view.commands[0]?.ok, false);
      assert.equal(view.commands[0]?.error, "not a git repository");
      assert.equal(projectCommandStatus(view.commands[0]!), "failed");
      assert.equal((await hive.call("admin.audit", { action: "machines.projectCommand" }, admin))[0]?.target, "hc");
    } finally { hive.close(); }
  });

  it("shows a deleted project still in a machine's config, and lets an admin queue its removal", async () => {
    const { hive, beat } = await hub();
    try {
      await beat();
      // The headstone projects.delete leaves (deleting for real needs a backup folder this test has no use for).
      hive.db.prepare(`INSERT INTO project_states(project, state, at, "by") VALUES ('gone', 'deleted', ?, 'admin')`).run(new Date().toISOString());
      await beat();
      const view = (await hive.call("machines.projects", {}, admin)).find((m) => m.machineId === machine.name)!;
      assert.deepEqual(view.repos.map((r) => [r.project, r.path, r.state]), [["demo", "/work/demo", null], ["gone", "/work/gone", "deleted"]]);
      // Adding it back is refused; removing it is the point.
      await assert.rejects(hive.call("machines.projectCommand", { machine: machine.name, op: "add", project: "gone", repo: "/work/gone" }, admin), isError("errors.projectDeleted"));
      const remove = await hive.call("machines.projectCommand", { machine: machine.name, op: "remove", project: "gone" }, admin);
      assert.equal(remove.repo, null);
      await assert.rejects(hive.call("machines.projectCommand", { machine: machine.name, op: "remove", project: "gone" }, admin), isError("errors.projectCommandOpen"));
    } finally { hive.close(); }
  });

  it("is a human hub admin's only, and refuses apps that never reported their repos", async () => {
    const { hive, beat } = await hub();
    try {
      await hive.call("machines.heartbeat", { machine: "hc", instance: "aaaaaaaa" }, machine);
      await assert.rejects(hive.call("machines.projectCommand", { machine: "hc", op: "remove", project: "demo" }, admin), isError("errors.machineAppTooOld"));
      await beat();
      const viaMcp: Actor = { ...admin, source: { via: "mcp" } };
      const lead: Actor = { name: "lead", account: "lead", role: "admin", access: owner.access };
      for (const actor of [owner, machine, viaMcp, lead]) {
        await assert.rejects(hive.call("machines.projectCommand", { machine: "hc", op: "remove", project: "demo" }, actor));
        await assert.rejects(hive.call("machines.projects", {}, actor));
      }
      await assert.rejects(hive.call("machines.projectCommand", { machine: "hc", op: "add", project: "never-heard", repo: "/work/x" }, admin), isError("errors.notFound"));
    } finally { hive.close(); }
  });

  it("validates every field of the order", async () => {
    const { hive, beat } = await hub();
    try {
      await beat();
      const bad = [
        { op: "add", project: "member-a" },
        { op: "add", project: "member-a", repo: "work/member-a" },
        { op: "add", project: "member-a", repo: "/work/../etc" },
        { op: "add", project: "member-a", repo: "\\\\server\\share\\repo" },
        { op: "add", project: "member-a", repo: "/work/a", cloneUrl: "https://oauth2:secret@gitlab.example.com/g/a.git" },
        { op: "add", project: "member-a", repo: "/work/a", cloneUrl: "ext::sh -c touch% /tmp/pwned" },
        { op: "add", project: "member-a", repo: "/work/a", cloneUrl: "file:///etc" },
        { op: "add", project: "member-a", repo: "/work/a", gitlabProject: "../x" },
        { op: "add", project: "Member A", repo: "/work/a" },
        { op: "remove", project: "demo", repo: "/work/demo" },
      ];
      for (const input of bad) await assert.rejects(hive.call("machines.projectCommand", { machine: "hc", ...input } as never, admin), (err) => err instanceof HiveError && err.code === "bad_request", JSON.stringify(input));
      assert.ok(isSafeRepoPath("C:\\Users\\dev\\repo") && isSafeRepoPath("D:/work/repo") && isSafeRepoPath("/home/dev/repo"));
      assert.ok(isSafeCloneUrl("https://gitlab.example.com/g/a.git") && isSafeCloneUrl("ssh://git@gitlab.example.com:2222/g/a.git") && isSafeCloneUrl("git@gitlab.example.com:g/a.git"));
      assert.ok(!isSafeCloneUrl("-uhttps://x/y") && !isSafeCloneUrl("http://gitlab.example.com/g/a.git") && !isSafeCloneUrl("git@host:../a"));
      assert.equal(projectOrderSchema.safeParse({ op: "add", project: "a", repo: "/x" }).success, true);
    } finally { hive.close(); }
  });

  it("upgrades the schema without inventing repos for existing machines", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("machines.heartbeat", { machine: "hc", instance: "aaaaaaaa" }, machine);
    const db = hive.db;
    const before = migrationIndex("CREATE TABLE machine_project_commands(");
    db.exec(`DROP TABLE machine_project_commands; ALTER TABLE machines DROP COLUMN repos; PRAGMA user_version = ${before}`);
    const upgraded = new SqliteHive(db, { migrateTo: before + 1 });
    try { assert.equal((await upgraded.call("machines.projects", {}, admin))[0]?.supported, false); }
    finally { upgraded.close(); }
  });
});
