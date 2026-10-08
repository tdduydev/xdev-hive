import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HiveError, parseSkill, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const claude: Actor = { name: "claude@duy", role: "agent" };
const codex: Actor = { name: "codex@duy", role: "agent" };
const viewer: Actor = { name: "pm", role: "viewer" };

const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof HiveError && e.code === code);

describe("docs", () => {
  it("versions every save and keeps history", async () => {
    const hive = new SqliteHive(":memory:");
    const v1 = await hive.call("docs.save", { key: "org/security", content: "No secrets", baseVersion: 0 }, admin);
    assert.equal(v1.version, 1);
    assert.equal(v1.includeInAgents, true, "org docs go into AGENTS.md by default");
    assert.equal(v1.title, "Security");
    const v2 = await hive.call("docs.save", { key: "org/security", content: "No secrets. Ever.", baseVersion: 1 }, admin);
    assert.equal(v2.version, 2);
    const history = await hive.call("docs.history", { key: "org/security" }, viewer);
    assert.deepEqual(history.map((h) => h.version), [2, 1]);
  });

  it("rejects a stale editor save", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "org/x", content: "a" }, admin);
    await hive.call("docs.save", { key: "org/x", content: "b" }, admin);
    await rejects(hive.call("docs.save", { key: "org/x", content: "c", baseVersion: 1 }, admin), "conflict");
  });

  it("lists org docs together with a project's docs", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "org/style", content: "x" }, admin);
    await hive.call("docs.save", { key: "project/app/agents", content: "x" }, admin);
    await hive.call("docs.save", { key: "project/other/agents", content: "x" }, admin);
    const keys = (await hive.call("docs.list", { project: "app" }, viewer)).map((d) => d.key);
    assert.deepEqual(keys, ["org/style", "project/app/agents"]);
  });

  it("enforces roles, key format and secret scanning", async () => {
    const hive = new SqliteHive(":memory:");
    await rejects(hive.call("docs.save", { key: "org/x", content: "a" }, claude), "forbidden");
    await rejects(hive.call("docs.save", { key: "Bad Key", content: "a" }, admin), "bad_request");
    await rejects(
      hive.call("docs.save", { key: "org/x", content: `token ${"glpat-"}${"a".repeat(20)}` }, admin),
      "bad_request",
    );
    // A fine-grained GitHub token (the kind the app asks for).
    await rejects(hive.call("docs.save", { key: "org/x", content: `${"github_pat_"}${"A1".repeat(40)}` }, admin), "bad_request");
  });

  it("seeds the agent protocol once", async () => {
    const hive = new SqliteHive(":memory:");
    hive.seed();
    hive.seed();
    const docs = await hive.call("docs.list", {}, viewer);
    assert.deepEqual(docs.map((d) => [d.key, d.version]), [["org/agent-protocol", 1]]);
  });

  it("gives a hub the chat leader's skill; a hub seeded before gets it once, and one removed stays removed", async () => {
    const hub = new SqliteHive(":memory:");
    hub.seed("hub", { hub: true });
    const [leader] = await hub.call("skills.list", {}, viewer);
    assert.equal(leader?.name, "hive-leader");
    assert.equal(leader?.scope, "org", "a team skill, edited on the Skills page like the others");
    const doc = (await hub.call("docs.get", { key: "org/skills/hive-leader" }, viewer))!;
    assert.equal(parseSkill(doc.content).name, "hive-leader");
    assert.match(doc.content, /propose_run/);

    // A hub from before seed versions were kept: its docs are there, the leader's skill is not.
    const old = new SqliteHive(":memory:");
    old.seed("hub");
    old.db.exec("DELETE FROM hive_meta");
    await old.call("docs.save", { key: "org/agent-protocol", content: "Ours now" }, admin);
    old.seed("hub", { hub: true });
    assert.deepEqual((await old.call("skills.list", {}, viewer)).map((s) => s.name), ["hive-leader"]);
    assert.equal((await old.call("docs.get", { key: "org/agent-protocol" }, viewer))!.content, "Ours now", "the first seed is not written again");
    old.db.exec("DELETE FROM docs WHERE key = 'org/skills/hive-leader'");
    old.seed("hub", { hub: true });
    assert.deepEqual(await old.call("skills.list", {}, viewer), [], "removed by the team: not brought back");

    // A machine's own database has no chat.
    const local = new SqliteHive(":memory:");
    local.seed();
    assert.deepEqual(await local.call("skills.list", {}, viewer), []);
  });
});

describe("proposals", () => {
  it("marks an interrupted operation as uncertain on reopening", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hive-operation-"));
    try {
      const filename = path.join(dir, "hive.db");
      const first = new SqliteHive(filename);
      await first.call("tasks.create", { id: "seed", project: "app", title: "Seed" }, admin);
      const actor: Actor = { name: "cli@owner", role: "member", mcpCredential: true, access: { projects: { app: "lead" } } };
      const proposal = await first.call("proposals.create", { action: { method: "agents.stop", project: "app", input: { project: "app" } }, reason: "Maintenance" }, actor);
      first.db.prepare("UPDATE proposals SET status = 'executing', reviewer = ?, decided_at = ? WHERE id = ?").run("duy", new Date().toISOString(), proposal.id);
      first.db.close();

      const reopened = new SqliteHive(filename);
      const recovered = (await reopened.call("proposals.list", {}, admin)).find((p) => p.id === proposal.id)!;
      assert.equal(recovered.status, "conflict");
      assert.match(recovered.reviewNote ?? "", /interrupted/i);
      await rejects(reopened.call("proposals.approve", { id: proposal.id }, admin), "bad_request");
      reopened.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies an approved proposal as a new version credited to the agent", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "project/app/agents", content: "old" }, admin);
    const p = await hive.call(
      "proposals.create",
      { docKey: "project/app/agents", baseVersion: 1, content: "new", reason: "add test cmd" },
      claude,
    );
    assert.equal(p.status, "pending");
    const approved = await hive.call("proposals.approve", { id: p.id }, admin);
    assert.equal(approved.status, "approved");
    const doc = await hive.call("docs.get", { key: "project/app/agents" }, viewer);
    assert.equal(doc?.content, "new");
    assert.equal(doc?.version, 2);
    assert.match(doc!.updatedBy, /claude@duy \(approved by duy\)/);
  });

  it("marks a proposal as conflict when the doc moved before approval", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "org/x", content: "v1" }, admin);
    const a = await hive.call("proposals.create", { docKey: "org/x", baseVersion: 1, content: "A", reason: "a" }, claude);
    const b = await hive.call("proposals.create", { docKey: "org/x", baseVersion: 1, content: "B", reason: "b" }, codex);
    await hive.call("proposals.approve", { id: a.id }, admin);
    const res = await hive.call("proposals.approve", { id: b.id }, admin);
    assert.equal(res.status, "conflict");
    assert.equal((await hive.call("docs.get", { key: "org/x" }, viewer))?.content, "A");
  });

  it("refuses proposals built on a stale version, and agent approvals", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("docs.save", { key: "org/x", content: "v1" }, admin);
    await rejects(
      hive.call("proposals.create", { docKey: "org/x", baseVersion: 0, content: "A", reason: "a" }, claude),
      "conflict",
    );
    const p = await hive.call("proposals.create", { docKey: "org/x", baseVersion: 1, content: "A", reason: "a" }, claude);
    await rejects(hive.call("proposals.approve", { id: p.id }, claude), "forbidden");
  });

  it("allows proposing a brand new doc with baseVersion 0", async () => {
    const hive = new SqliteHive(":memory:");
    const p = await hive.call(
      "proposals.create",
      { docKey: "project/app/decisions", baseVersion: 0, content: "# Decisions", reason: "start ADR log" },
      claude,
    );
    await hive.call("proposals.approve", { id: p.id }, admin);
    assert.equal((await hive.call("docs.get", { key: "project/app/decisions" }, viewer))?.version, 1);
  });
});

describe("memory", () => {
  it("finds entries with or without Vietnamese diacritics", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("memory.write", { project: "app", kind: "decision", content: "Quyết định dùng pnpm workspaces" }, claude);
    await hive.call("memory.write", { project: "app", kind: "gotcha", content: "Redis cần TLS ở staging" }, codex);
    await hive.call("memory.write", { project: "other", kind: "gotcha", content: "pnpm không dùng ở đây" }, codex);
    const hits = await hive.call("memory.search", { project: "app", query: "quyet dinh" }, viewer);
    assert.deepEqual(hits.map((m) => m.author), ["claude@duy"]);
    const prefix = await hive.call("memory.search", { project: "app", query: "redi" }, viewer);
    assert.equal(prefix.length, 1);
    const latest = await hive.call("memory.search", { project: "app" }, viewer);
    assert.equal(latest.length, 2);
  });

  it("hides pending memory from search until an admin approves it", async () => {
    const hive = new SqliteHive(":memory:", { memoryRequiresApproval: true });
    const m = await hive.call("memory.write", { project: "app", kind: "convention", content: "Dùng zod ở biên" }, claude);
    assert.equal(m.status, "pending");
    assert.equal((await hive.call("memory.search", { project: "app", query: "zod" }, viewer)).length, 0);
    await hive.call("memory.approve", { id: m.id }, admin);
    assert.equal((await hive.call("memory.search", { project: "app", query: "zod" }, viewer)).length, 1);
    await hive.call("memory.remove", { id: m.id }, admin);
    assert.equal((await hive.call("memory.search", { project: "app", query: "zod" }, viewer)).length, 0);
  });

  it("refuses secrets", async () => {
    const hive = new SqliteHive(":memory:");
    await rejects(
      hive.call("memory.write", { project: "app", kind: "context", content: `key ${"AKIA"}${"A".repeat(16)}` }, claude),
      "bad_request",
    );
  });
});

describe("tasks", () => {
  it("leases a task to one agent at a time", async () => {
    let now = new Date("2026-09-27T08:00:00Z");
    const hive = new SqliteHive(":memory:", { now: () => now });
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "Login page" }, admin);
    assert.equal((await hive.call("tasks.claim", { id: "T-1", leaseMinutes: 30 }, claude)).claimed, true);
    assert.equal((await hive.call("tasks.claim", { id: "T-1" }, codex)).claimed, false);
    await rejects(hive.call("tasks.update", { id: "T-1", status: "review" }, codex), "forbidden");

    now = new Date("2026-09-27T08:31:00Z");
    const stolen = await hive.call("tasks.claim", { id: "T-1" }, codex);
    assert.equal(stolen.claimed, true, "expired lease can be taken over");
    assert.equal(stolen.task?.owner, "codex@duy");

    const done = await hive.call("tasks.update", { id: "T-1", status: "review", note: "Done; run npm test" }, codex);
    assert.equal(done.owner, null);
    assert.equal(done.note, "Done; run npm test");
  });
});
