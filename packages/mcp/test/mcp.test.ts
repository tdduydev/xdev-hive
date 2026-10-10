import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHiveMcpServer, type HiveMcpOptions } from "#mcp/index.ts";
import { stdioActor } from "#mcp/stdio-actor.ts";

async function connect(hive: SqliteHive, name = "claude@duy", opts: { role?: "agent" | "viewer"; readOnly?: boolean } = {}) {
  const server = createHiveMcpServer(hive, { name, role: opts.role ?? "agent" }, { defaultProject: "app", readOnly: opts.readOnly });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0]!.text;

describe("mcp tools", () => {
  it("shows CLI leader tools only to an interactive credential with the matching grant", async () => {
    const hive = new SqliteHive(":memory:");
    const base: Actor = { name: "claude@owner", role: "member", mcpCredential: true, agent: "claude", onBehalf: "owner", access: { projects: { app: "lead" } } };
    const names = async (actor: Actor) => (await (await connectAs(hive, actor)).listTools()).tools.map((tool) => tool.name);
    const lead = await names(base);
    for (const tool of ["task_create", "task_set_deps", "task_status", "task_assign", "run_dispatch", "plan_create"]) assert.ok(lead.includes(tool), tool);
    const member = await names({ ...base, access: { projects: { app: "member" } } });
    assert.ok(member.includes("task_status"));
    assert.ok(!member.includes("task_create"));
    assert.ok(!member.includes("run_dispatch"));
    assert.ok(!member.includes("plan_create"));
    const viewerGrant = await names({ ...base, access: { projects: { app: "viewer" } } });
    assert.ok(!viewerGrant.includes("task_create"));
    assert.ok(!viewerGrant.includes("propose_merge"));
    for (const actor of [{ ...base, role: "viewer" as const }, { ...base, runCredential: { project: "app", task: "T-1", run: "R-1", machine: "m", readOnly: false } }, { ...base, chatReply: 1 }]) {
      const found = await names(actor);
      assert.ok(!found.includes("task_create"));
      assert.ok(!found.includes("run_dispatch"));
    }
  });

  it("shows and executes CLI leader tools for the stdio shim actor", async () => {
    const hive = new SqliteHive(":memory:");
    for (const mode of ["local", "hub"] as const) {
      const actor = stdioActor(mode, "mini", "owner", { HIVE_AGENT: "codex" });
      const client = await connectAs(hive, actor);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.ok(names.includes("task_create"), mode);
      assert.ok(names.includes("plan_create"), mode);
      const created = await client.callTool({ name: "task_create", arguments: { id: `stdio-${mode}`, project: "app", title: "From stdio" } });
      assert.equal(created.isError, undefined, text(created));
      for (const env of [{ HIVE_RUN: "R-1" }, { HIVE_READONLY: "1" }, ...(mode === "local" ? [{ HIVE_CHAT_REPLY: "1" }] : [])]) {
        const restricted = await connectAs(hive, stdioActor(mode, "mini", "owner", env), { readOnly: env.HIVE_READONLY === "1" });
        assert.ok(!(await restricted.listTools()).tools.some((tool) => tool.name === "task_create"));
      }
    }
  });

  it("creates a CLI plan atomically with agent audit and rejects a cyclic plan", async () => {
    const hive = new SqliteHive(":memory:");
    const admin: Actor = { name: "admin", role: "admin" };
    await hive.call("tasks.create", { id: "seed", project: "app", title: "Seed" }, admin);
    const actor: Actor = { name: "codex@owner", role: "member", mcpCredential: true, access: { projects: { app: "lead" } }, agent: "codex", onBehalf: "owner", source: { via: "mcp" } };
    const client = await connectAs(hive, actor);
    const plan = { project: "app", spec: { key: "project/app/cli-plan", title: "CLI plan", content: "Build the feature" }, tasks: [
      { id: "T-1", title: "First", acceptance: "First works", dependsOn: [] },
      { id: "T-2", title: "Second", acceptance: "Second works", dependsOn: ["T-1"] },
    ], batches: [{ title: "One", taskIds: ["T-1"] }, { title: "Two", taskIds: ["T-2"] }] };
    const created = await client.callTool({ name: "plan_create", arguments: plan });
    assert.equal(created.isError, undefined, text(created));
    assert.deepEqual(JSON.parse(text(created)).taskIds, ["T-1", "T-2"]);
    assert.deepEqual((await hive.call("tasks.list", { project: "app" }, admin)).find((task) => task.id === "T-2")?.dependsOn, ["T-1"]);
    assert.equal((await hive.call("admin.audit", { action: "tasks.create" }, admin)).find((entry) => entry.target === "T-2")?.onBehalf, "owner");
    const cyclic = await client.callTool({ name: "plan_create", arguments: { ...plan, spec: { ...plan.spec, key: "project/app/cli-cycle" }, tasks: [
      { id: "T-3", title: "Third", acceptance: "Third works", dependsOn: ["T-4"] },
      { id: "T-4", title: "Fourth", acceptance: "Fourth works", dependsOn: ["T-3"] },
    ], batches: [{ title: "Cycle", taskIds: ["T-3", "T-4"] }] } });
    assert.equal(cyclic.isError, true);
    assert.equal(await hive.call("docs.get", { key: "project/app/cli-cycle" }, admin), null);
  });

  it("keeps a CLI operation pending until someone approves it on the hub", async () => {
    const hive = new SqliteHive(":memory:");
    const admin: Actor = { name: "admin", role: "admin" };
    await hive.call("tasks.create", { id: "seed", project: "app", title: "Seed" }, admin);
    const actor: Actor = { name: "codex@owner", role: "member", mcpCredential: true, access: { projects: { app: "lead" } }, agent: "codex", onBehalf: "owner", source: { via: "mcp" } };
    const client = await connectAs(hive, actor);
    const proposed = await client.callTool({ name: "propose_stop_agents", arguments: { project: "app", reason: "Maintenance" } });
    assert.equal(proposed.isError, undefined, text(proposed));
    const { id, status } = JSON.parse(text(proposed));
    assert.equal(status, "pending");
    const proposalAudit = (await hive.call("admin.audit", { action: "proposals.create" }, admin))[0]!;
    assert.deepEqual([proposalAudit.agent, proposalAudit.onBehalf], ["codex", "owner"]);
    assert.deepEqual((await hive.call("agents.paused", {}, admin)).projects, []);
    assert.equal((await hive.call("proposals.list", { status: "pending" }, admin)).some((proposal) => proposal.id === id), true);
    await assert.rejects(hive.call("proposals.approve", { id }, actor), /agent credential|human session/i);
    await assert.rejects(hive.call("proposals.approve", { id }, { ...actor, mcpCredential: false, runCredential: { project: "app", task: "seed", run: "R-1", machine: "m", readOnly: false } }), /agent credential|human session/i);
    const owner: Actor = { name: "owner", role: "member", humanSession: "session-owner", access: { projects: { app: "lead" } } };
    for (const caller of [
      { ...owner, humanSession: undefined },
      { ...owner, role: "agent" as const },
      { ...owner, source: { via: "mcp" as const } },
      { ...owner, mcpCredential: true },
      { ...owner, runCredential: { project: "app", task: "seed", run: "R-1", machine: "m", readOnly: false } },
      { ...owner, chatReply: 1 },
    ]) await assert.rejects(hive.call("proposals.approve", { id }, caller), /agent credential|human session/i);
    const approval = hive.call("proposals.approve", { id }, owner);
    assert.equal((await hive.call("proposals.list", {}, admin)).find((p) => p.id === id)?.status, "executing", "approval is not recorded before execution finishes");
    await assert.rejects(hive.call("proposals.approve", { id }, owner), /already decided/);
    assert.equal((await approval).status, "approved");
    assert.deepEqual((await hive.call("agents.paused", {}, admin)).projects, ["app"]);
    await assert.rejects(hive.call("proposals.create", { action: { method: "agents.resume", project: "app", input: { project: "app" } }, reason: "No right" }, { ...actor, access: { projects: { app: "viewer" } } }), /docPropose/);
    await assert.rejects(hive.call("proposals.create", { action: { method: "agents.stop", project: null, input: { project: null } }, reason: "Hub-wide" }, actor), /admin|Admin/);
    await assert.rejects(hive.call("proposals.create", { action: { method: "admin.commandCreate", project: "app", input: { machineId: "m", itemId: "other:agents" } }, reason: "Wrong service" }, actor), /another project/);
  });
  it("exposes the agent tool set without task management", async () => {
    const client = await connect(new SqliteHive(":memory:"));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "artifact_get",
      "artifact_list",
      "artifact_put",
      "cost_summary",
      "doc_asset",
      "doc_get",
      "doc_list",
      "doc_propose",
      "machine_list",
      "memory_search",
      "memory_write",
      "policy_get",
      "project_list",
      "run_count",
      "run_get",
      "run_list",
      "run_requests",
      "setup_missing",
      "skill_get",
      "skill_list",
      "skill_propose",
      "task_claim",
      "task_get",
      "task_list",
      "task_next",
      "task_notes",
      "task_update",
      "token_usage",
      "tool_list",
      "tool_status",
    ]);
  });

  it("shows task_create only to task managers and keeps run credentials from changing platforms", async () => {
    const hive = new SqliteHive(":memory:");
    const admin: Actor = { name: "duy", role: "admin" };
    // task_create is the CLI leader's (71a): an interactive credential of an account with taskManage.
    const manager: Actor = { name: "claude@lan", role: "member", mcpCredential: true, agent: "claude", onBehalf: "lan", access: { projects: { app: "lead" } } };
    const member: Actor = { ...manager, name: "claude@minh", onBehalf: "minh", access: { projects: { app: "member" } } };
    const run: Actor = { name: "run-agent", role: "agent", runCredential: { project: "app", task: "T-1", run: "R-1", machine: "mini", readOnly: false } };
    const has = async (actor: Actor, name: string) => (await (await connectAs(hive, actor)).listTools()).tools.some((t) => t.name === name);
    assert.equal(await has(member, "task_create"), false);
    assert.equal(await has(run, "task_create"), false);
    assert.equal(await has({ ...manager, chatReply: 1 }, "task_create"), false);
    assert.equal(await has(manager, "task_create"), true);
    const memberUpdate = (await (await connectAs(hive, member)).listTools()).tools.find((t) => t.name === "task_update")!;
    assert.equal(Object.hasOwn((memberUpdate.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}, "platforms"), false);

    const client = await connectAs(hive, manager);
    const created = JSON.parse(text(await client.callTool({ name: "task_create", arguments: { id: "T-1", project: "app", title: "Mac task", platforms: ["mac"] } })));
    assert.deepEqual(created.platforms, ["mac"]);
    const changed = JSON.parse(text(await client.callTool({ name: "task_update", arguments: { id: "T-1", platforms: ["linux"] } })));
    assert.deepEqual([changed.platforms, changed.status], [["linux"], "todo"]);

    const runClient = await connectAs(hive, run);
    const update = (await runClient.listTools()).tools.find((t) => t.name === "task_update")!;
    assert.equal(Object.hasOwn((update.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}, "platforms"), false);
    const attempted = await runClient.callTool({ name: "task_update", arguments: { id: "T-1", status: "review", platforms: ["windows"] } });
    assert.notEqual(attempted.isError, true);
    assert.deepEqual((await hive.call("tasks.list", { project: "app" }, admin))[0]?.platforms, ["linux"]);
    await assert.rejects(hive.call("tasks.update", { id: "T-1", platforms: ["windows"] }, run), /cannot create tasks or change/);
    hive.close();
  });

  it("gives read-only agents and viewer tokens the read tools only", async () => {
    const hive = new SqliteHive(":memory:");
    for (const client of [await connect(hive, "claude@duy", { readOnly: true }), await connect(hive, "ci", { role: "viewer" })]) {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
        "artifact_get",
        "artifact_list",
        "cost_summary",
        "doc_asset",
        "doc_get",
        "doc_list",
        "machine_list",
        "memory_search",
        "policy_get",
        "project_list",
        "run_count",
        "run_get",
        "run_list",
        "run_requests",
        "setup_missing",
        "skill_get",
        "skill_list",
        "task_get",
        "task_list",
        "task_next",
        "task_notes",
        "token_usage",
        "tool_list",
        "tool_status",
      ]);
      assert.match(client.getInstructions() ?? "", /read-only/);
      const called = await client.callTool({ name: "memory_write", arguments: { kind: "decision", content: "x" } }).catch((e: Error) => e);
      assert.ok(called instanceof Error || (called as { isError?: boolean }).isError, "a hidden tool cannot be called either");
    }
    assert.equal((await hive.call("memory.list", {}, { name: "duy", role: "admin" })).length, 0);
  });

  it("lists and reads skills, the project's first, and takes new ones as proposals", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`;
    await hive.call("docs.save", { key: "org/skills/release", content: skill("release", "Team release.") }, admin);
    await hive.call("docs.save", { key: "org/skills/review-pr", content: skill("review-pr", "Team review.") }, admin);
    await hive.call("docs.save", { key: "project/app/skills/release", content: skill("release", "App release.") }, admin);
    const claude = await connect(hive, "claude@duy");
    assert.match(claude.getInstructions() ?? "", /skill_list/);

    const listed = JSON.parse(text(await claude.callTool({ name: "skill_list", arguments: {} })));
    assert.deepEqual(listed.map((s: { name: string; description: string }) => [s.name, s.description]), [["release", "App release."], ["review-pr", "Team review."]]);
    const own = JSON.parse(text(await claude.callTool({ name: "skill_get", arguments: { name: "release" } })));
    assert.equal(own.key, "project/app/skills/release");
    const team = JSON.parse(text(await claude.callTool({ name: "skill_get", arguments: { name: "review-pr" } })));
    assert.equal(team.key, "org/skills/review-pr", "the team's when the project has none");
    const missing = await claude.callTool({ name: "skill_get", arguments: { name: "nope" } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /no skill nope/);

    const bad = await claude.callTool({ name: "skill_propose", arguments: { name: "deploy", content: "no front matter", reason: "x", baseVersion: 0 } });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /front matter/);
    const shared = JSON.parse(
      text(await claude.callTool({ name: "skill_propose", arguments: { name: "deploy", content: skill("deploy", "Deploy."), reason: "every project does it", baseVersion: 0, shared: true } })),
    );
    assert.equal(shared.docKey, "org/skills/deploy");
    const mine = JSON.parse(text(await claude.callTool({ name: "skill_propose", arguments: { name: "deploy", content: skill("deploy", "App deploy."), reason: "app only", baseVersion: 0 } })));
    assert.equal(mine.docKey, "project/app/skills/deploy");
  });

  it("suggests the next ready task and refuses to claim one that waits", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "API" }, admin);
    await hive.call("tasks.create", { id: "T-2", project: "app", title: "UI", dependsOn: ["T-1"] }, admin);
    const claude = await connect(hive, "claude@duy");
    const next = JSON.parse(text(await claude.callTool({ name: "task_next", arguments: {} })));
    assert.deepEqual(next.map((t: { id: string }) => t.id), ["T-1"]);
    const listed = JSON.parse(text(await claude.callTool({ name: "task_list", arguments: {} })));
    assert.deepEqual(listed.find((t: { id: string }) => t.id === "T-2").waitingOn, ["T-1"]);
    const claim = await claude.callTool({ name: "task_claim", arguments: { id: "T-2" } });
    assert.equal(claim.isError, true);
    assert.match(text(claim), /waits on T-1/);
  });

  it("cuts the notes a task list carries, and reads one task in full (roadmap 28f)", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const long = `ĐÃ LÀM: ${"chi tiết bàn giao ".repeat(40)}`;
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "API" }, admin);
    await hive.call("tasks.update", { id: "T-1", status: "review", note: long }, admin);
    await hive.call("tasks.create", { id: "T-2", project: "app", title: "UI" }, admin);
    await hive.call("tasks.update", { id: "T-2", status: "review", note: "Xong, đã chạy test" }, admin);
    const claude = await connect(hive, "claude@duy");

    const answer = await claude.callTool({ name: "task_list", arguments: {} });
    assert.equal(text(answer).includes("\n"), false, "JSON without indentation");
    const listed = JSON.parse(text(answer)) as Array<{ id: string; note: string; noteTruncated?: boolean }>;
    const cut = listed.find((t) => t.id === "T-1")!;
    assert.deepEqual([cut.note, cut.note.length, cut.noteTruncated], [long.slice(0, 200), 200, true]);
    const short = listed.find((t) => t.id === "T-2")!;
    assert.deepEqual([short.note, "noteTruncated" in short], ["Xong, đã chạy test", false], "a note that fits is left alone");

    const whole = JSON.parse(text(await claude.callTool({ name: "task_list", arguments: { full: true } }))) as Array<{ id: string; note: string; noteTruncated?: boolean }>;
    const kept = whole.find((t) => t.id === "T-1")!;
    assert.deepEqual([kept.note, "noteTruncated" in kept], [long, false]);

    const one = JSON.parse(text(await claude.callTool({ name: "task_get", arguments: { id: "T-1" } })));
    assert.deepEqual([one.id, one.status, one.note], ["T-1", "review", long]);
    const missing = await claude.callTool({ name: "task_get", arguments: { id: "T-9" } });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /^not_found: Task T-9/);
  });

  it("leaves done tasks, the project and empty fields out of the board unless asked (roadmap 80a)", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    for (const id of ["T-1", "T-2", "T-3"]) await hive.call("tasks.create", { id, project: "app", title: id }, admin);
    await hive.call("tasks.update", { id: "T-1", status: "done", note: "Xong: đã merge" }, admin);
    await hive.call("tasks.update", { id: "T-2", status: "review", note: "Chờ review" }, admin);
    const claude = await connect(hive, "claude@duy");
    const list = async (args: Record<string, unknown>) =>
      JSON.parse(text(await claude.callTool({ name: "task_list", arguments: args }))) as Array<Record<string, unknown>>;

    const open = await list({});
    assert.deepEqual(open.map((t) => t.id).sort(), ["T-2", "T-3"], "done is left out by default");
    const t3 = open.find((t) => t.id === "T-3")!;
    for (const key of ["project", "owner", "leaseUntil", "note", "platforms", "dependsOn", "waitingOn", "kind", "agent"]) assert.ok(!(key in t3), key);
    assert.equal(open.find((t) => t.id === "T-2")!.note, "Chờ review", "an open task keeps its note");

    const done = await list({ status: "done" });
    assert.deepEqual(done.map((t) => [t.id, t.status, "note" in t]), [["T-1", "done", false]], "a done task comes without its note");
    const all = await list({ includeDone: true });
    assert.deepEqual(all.map((t) => t.id).sort(), ["T-1", "T-2", "T-3"]);
    assert.ok(!("note" in all.find((t) => t.id === "T-1")!));

    const full = await list({ full: true });
    const whole = full.find((t) => t.id === "T-1")!;
    assert.deepEqual([full.length, whole.project, whole.note, whole.owner], [3, "app", "Xong: đã merge", null], "full: the hub's record unchanged");
  });

  it("gives a run's log tail and patch summary, and everything with full (roadmap 80b)", async (t) => {
    const hive = new SqliteHive(":memory:");
    const mbp = { name: "runner.duy-mbp@duy-mbp", role: "agent" as const };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true }, mbp);
    const log = Array.from({ length: 1500 }, (_, i) => `▶ bước ${i}: đọc file và chạy test`).join("\n") + "\n✓ KẾT QUẢ: xong";
    const hunk = (f: string) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-${"cũ ".repeat(2000)}\n+${"mới ".repeat(2000)}\n`;
    const patch = ["src/a.ts", "src/b.ts", "docs/c.md"].map(hunk).join("");
    const at = "2026-09-29T10:00:00.000Z";
    const runs = [
      { runId: "R-big", project: "app", taskId: "T-1", taskTitle: "Big", role: "implement" as const, status: "succeeded" as const, profileId: "claude-1", summary: "Done", log, patch, createdAt: at },
      { runId: "R-small", project: "app", taskId: "T-2", taskTitle: "Small", role: "review" as const, status: "succeeded" as const, profileId: "claude-1", summary: "OK", log: "▶ Read\n✓ ok", createdAt: at },
    ];
    await hive.call("runs.push", { machine: "duy-mbp", runs }, mbp);
    const claude = await connect(hive, "claude-1.duy-mbp@chat-lan");
    const get = async (runId: string, full?: boolean) =>
      text(await claude.callTool({ name: "run_get", arguments: { machineId: mbp.name, runId, ...(full ? { full } : {}) } }));

    const leanText = await get("R-big");
    const lean = JSON.parse(leanText);
    assert.ok(!("patch" in lean), "no patch by default");
    assert.deepEqual([lean.patchLength, lean.patchFiles], [patch.length, ["src/a.ts", "src/b.ts", "docs/c.md"]]);
    assert.equal(lean.logTruncated, true);
    assert.equal(lean.logLength, log.length);
    assert.ok(lean.log.length <= 8_000 && lean.log.startsWith("▶ bước"), "the tail starts on a whole line");
    assert.ok(lean.log.endsWith("✓ KẾT QUẢ: xong"), "the end of the log is kept");

    const small = JSON.parse(await get("R-small"));
    assert.deepEqual([small.log, "logTruncated" in small, "patchLength" in small], ["▶ Read\n✓ ok", false, false]);

    const fullText = await get("R-big", true);
    const whole = JSON.parse(fullText);
    assert.deepEqual([whole.patch, whole.log.length > lean.log.length, "logTruncated" in whole], [patch, true, false]);
    t.diagnostic(`run_get: ${Buffer.byteLength(fullText)} B full, ${Buffer.byteLength(leanText)} B by default`);
  });

  it("doc_list is short and doc_get cuts by section or maxChars (roadmap 80c)", async (t) => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const big = "# Tài liệu\n" + Array.from({ length: 40 }, (_, i) => `## Mục ${i}\n${"dòng nội dung\n".repeat(60)}### Con ${i}\nchi tiết ${i}\n`).join("");
    await hive.call("docs.save", { key: "org/big", content: big }, admin);
    const claude = await connect(hive);
    const call = async (name: string, args: Record<string, unknown>) => text(await claude.callTool({ name, arguments: args }));
    const leanList = await call("doc_list", {});
    const fullList = await call("doc_list", { full: true });
    const row = JSON.parse(leanList).find((d: { key: string }) => d.key === "org/big");
    assert.deepEqual(Object.keys(row).sort(), ["key", "title", "version"]);
    assert.ok(leanList.length < fullList.length, "lean list is shorter");

    const cut = JSON.parse(await call("doc_get", { key: "org/big" }));
    assert.equal(cut.truncated, true);
    assert.equal(cut.length, big.length);
    assert.ok(cut.content.length <= 12_000 && cut.version >= 1 && cut.headings.includes("## Mục 39"));
    const small = JSON.parse(await call("doc_get", { key: "org/big", maxChars: 800 }));
    assert.ok(small.content.length <= 800 && !small.content.endsWith("dòng nội dun"), "cut on a line");

    const sec = JSON.parse(await call("doc_get", { key: "org/big", section: "Mục 3" }));
    assert.ok(sec.content.startsWith("## Mục 3\n") && sec.content.includes("### Con 3") && !sec.content.includes("## Mục 4"));
    assert.equal(sec.truncated, undefined);
    const miss = JSON.parse(await call("doc_get", { key: "org/big", section: "Không có" }));
    assert.equal(miss.sectionNotFound, "Không có");

    const whole = JSON.parse(await call("doc_get", { key: "org/big", full: true }));
    assert.equal(whole.content, big);
    t.diagnostic(`doc_list ${leanList.length} B vs ${fullList.length} B; doc_get ${JSON.stringify(cut).length} B vs ${JSON.stringify(whole).length} B`);
  });

  it("doc_get section ignores headings inside longer fences and reports the heading it picked (roadmap 80c)", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const fence = "````";
    const content = [
      "# Doc", "## Setup", "intro", fence + "md", "```sh", "# Fake", "```", "# Still code", fence, "tail of setup",
      "## Setup advanced", "advanced body", "## Other", "other body",
    ].join("\n");
    await hive.call("docs.save", { key: "org/fenced", content }, admin);
    const claude = await connect(hive);
    const get = async (args: Record<string, unknown>) => JSON.parse(text(await claude.callTool({ name: "doc_get", arguments: { key: "org/fenced", ...args } })));

    const setup = await get({ section: "Setup" });
    assert.equal(setup.section, "Setup");
    assert.ok(setup.content.includes("# Still code") && setup.content.includes("tail of setup") && !setup.content.includes("advanced body"));
    assert.ok(!setup.headings.includes("# Fake") && !setup.headings.includes("# Still code"));

    const adv = await get({ section: "Setup advanced" });
    assert.equal(adv.section, "Setup advanced");
    assert.ok(adv.content.startsWith("## Setup advanced") && !adv.content.includes("other body"));
    const partial = await get({ section: "advanced" });
    assert.equal(partial.section, "Setup advanced");
  });

  it("doc_get preserves literal trailing hashes in section titles (roadmap 80c)", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const content = ["# Doc", "## C#", "C# body", "## F# ###  ", "F# body", "## Other", "other body"].join("\n");
    await hive.call("docs.save", { key: "org/hashes", content }, admin);
    const claude = await connect(hive);
    const get = async (section: string) => JSON.parse(text(await claude.callTool({ name: "doc_get", arguments: { key: "org/hashes", section } })));

    const csharp = await get("C#");
    assert.equal(csharp.section, "C#");
    assert.equal(csharp.content, "## C#\nC# body");
    assert.deepEqual(csharp.headings, ["# Doc", "## C#", "## F#", "## Other"]);
    const fsharp = await get("F#");
    assert.equal(fsharp.section, "F#");
    assert.equal(fsharp.content, "## F# ###  \nF# body");
  });

  it("doc_get finds headings indented up to three spaces and ends preceding sections there (roadmap 80c)", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const content = [
      "# Doc", "## Before", "before body", " ## One", "one body", "  ## Two", "two body",
      "   ## Three", "three body", "    ## Code", "still three body", "## After", "after body",
    ].join("\n");
    await hive.call("docs.save", { key: "org/indented", content }, admin);
    const claude = await connect(hive);
    const get = async (section: string) => JSON.parse(text(await claude.callTool({ name: "doc_get", arguments: { key: "org/indented", section } })));

    const before = await get("Before");
    assert.equal(before.content, "## Before\nbefore body");
    assert.deepEqual(before.headings, ["# Doc", "## Before", "## One", "## Two", "## Three", "## After"]);
    for (const [section, body] of [
      ["One", " ## One\none body"], ["Two", "  ## Two\ntwo body"],
      ["Three", "   ## Three\nthree body\n    ## Code\nstill three body"],
    ] as const) {
      const doc = await get(section);
      assert.equal(doc.section, section);
      assert.equal(doc.content, body);
    }
  });

  it("says whose task each one is, and keeps another machine's agent off it (roadmap 50)", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const mbp = { name: "runner.duy-mbp@duy-mbp", role: "agent" as const };
    const mini = { name: "runner.lan-mini@lan-mini", role: "agent" as const };
    const plan = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0 };
    for (const m of [mbp, mini]) {
      await hive.call("machines.heartbeat", { machine: m.name.split("@")[1]!, instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true, profiles: [plan] }, m);
    }
    for (const n of [1, 2]) await hive.call("tasks.create", { id: `T-${n}`, project: "app", title: `Task ${n}` }, admin);
    await hive.call("tasks.assign", { id: "T-1", machineId: mbp.name, profileId: "claude-1" }, admin);
    await hive.call("tasks.assign", { id: "T-2", machineId: mini.name }, admin);

    // An agent run by the CLI on duy-mbp: its write source says which machine it sits on.
    const onMbp = await connectAs(hive, { name: "claude-1.duy-mbp@duy", role: "agent", agent: "claude-1.duy-mbp", source: { via: "mcp", machine: "duy-mbp" } });
    const listed = JSON.parse(text(await onMbp.callTool({ name: "task_list", arguments: {} }))) as Array<{ id: string; agent?: string }>;
    assert.deepEqual(listed.map((t) => [t.id, t.agent]).sort(), [["T-1", "duy-mbp/claude-1"], ["T-2", "lan-mini"]], "machine/plan, or the machine alone");
    const one = JSON.parse(text(await onMbp.callTool({ name: "task_get", arguments: { id: "T-1" } })));
    assert.deepEqual([one.agent.machine, one.agent.profileId, one.agent.by, one.agent.hold], ["duy-mbp", "claude-1", "duy", null], "the whole thing for one task");

    const next = JSON.parse(text(await onMbp.callTool({ name: "task_next", arguments: {} }))) as Array<{ id: string }>;
    assert.deepEqual(next.map((t) => t.id), ["T-1"], "lan-mini's task is not this machine's to take");
    const refused = await onMbp.callTool({ name: "task_claim", arguments: { id: "T-2" } });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /lan-mini/);
    assert.equal(JSON.parse(text(await onMbp.callTool({ name: "task_claim", arguments: { id: "T-1" } }))).claimed, true);
  });

  it("gives agents the memory fields they act on, eight at a time (roadmap 28f)", async () => {
    const hive = new SqliteHive(":memory:");
    const agent = { name: "claude@duy", role: "agent" as const };
    const claude = await connect(hive, agent.name);
    for (let i = 1; i <= 10; i++) await claude.callTool({ name: "memory_write", arguments: { kind: "context", content: `Ghi chú ${i}` } });
    const pool = JSON.parse(text(await claude.callTool({ name: "memory_write", arguments: { kind: "gotcha", content: "Đóng pool trong test", taskId: "T-1", files: ["src/db/pool.ts"] } })));
    const other = JSON.parse(text(await claude.callTool({ name: "memory_write", arguments: { kind: "decision", content: "Pool tự đóng khi hết test", contradicts: pool.id } })));
    // A cited file that changed since the baseline: the entry comes back with review set.
    const sha = (c: string) => c.repeat(40);
    for (const s of [sha("a"), sha("b")]) await hive.call("memory.checkFiles", { project: "app", files: [{ path: "src/db/pool.ts", sha: s }] }, agent);

    const [hit] = JSON.parse(text(await claude.callTool({ name: "memory_search", arguments: { query: "pool trong test" } }))) as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(hit!).sort(), ["conflictsWith", "content", "files", "id", "kind", "review", "taskId"], "no author, project, dates or use count");
    assert.deepEqual([hit!.files, hit!.taskId, hit!.review, hit!.conflictsWith], [["src/db/pool.ts"], "T-1", true, [other.id]], "paths without their blob ids, and flags only");

    const latest = JSON.parse(text(await claude.callTool({ name: "memory_search", arguments: {} }))) as unknown[];
    assert.equal(latest.length, 8, "8 by default, not the 10 of the RPC");
    assert.equal(JSON.parse(text(await claude.callTool({ name: "memory_search", arguments: { limit: 3 } }))).length, 3);
    const [verbose] = JSON.parse(text(await claude.callTool({ name: "memory_search", arguments: { query: "pool trong test", verbose: true } })));
    // The baseline blob id stays the one the entry was written against until a person keeps it; review.current holds what the file is now.
    assert.deepEqual([verbose.author, verbose.files, verbose.review.changed], [agent.name, [{ path: "src/db/pool.ts", sha: sha("a") }], ["src/db/pool.ts"]]);
  });

  it("answers a 120-task board and a memory search in a fraction of the bytes (roadmap 28f)", async (t) => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const note = `ĐÃ LÀM: ${"chi tiết bàn giao ".repeat(100)}`.slice(0, 1900);
    for (let i = 1; i <= 120; i++) {
      await hive.call("tasks.create", { id: `T-${i}`, project: "app", title: `Việc ${i}` }, admin);
      await hive.call("tasks.update", { id: `T-${i}`, status: "review", note }, admin);
    }
    const claude = await connect(hive, "claude@duy");
    for (let i = 1; i <= 20; i++) {
      await claude.callTool({ name: "memory_write", arguments: { kind: "convention", content: `Quy ước ${i}: ${"một câu đủ dài để đo ".repeat(10)}`, taskId: `T-${i}`, files: ["src/db/pool.ts", "src/web/app.ts"] } });
    }
    const bytes = (s: string) => Buffer.byteLength(s, "utf8");
    // What the tool answered before 28f: every field, indented.
    const was = (s: string) => bytes(JSON.stringify(JSON.parse(s), null, 2));

    const tasksFull = text(await claude.callTool({ name: "task_list", arguments: { full: true } }));
    const tasksNow = bytes(text(await claude.callTool({ name: "task_list", arguments: {} })));
    const memoryFull = text(await claude.callTool({ name: "memory_search", arguments: { limit: 20, verbose: true } }));
    const memoryNow = bytes(text(await claude.callTool({ name: "memory_search", arguments: { limit: 20 } })));
    t.diagnostic(`task_list (120 tasks, notes of ${note.length} chars): ${was(tasksFull)} B before, ${tasksNow} B now`);
    t.diagnostic(`memory_search (20 entries): ${was(memoryFull)} B before, ${memoryNow} B now`);
    assert.ok(tasksNow * 5 < was(tasksFull), `task_list ${tasksNow} B of ${was(tasksFull)} B`);
    // Memory keeps less to cut: the content is the point and stays whole, so the saving is the bookkeeping around it.
    assert.ok(memoryNow * 2 < was(memoryFull), `memory_search ${memoryNow} B of ${was(memoryFull)} B`);
  });

  it("shares memory between two agents", async () => {
    const hive = new SqliteHive(":memory:");
    const claude = await connect(hive, "claude@duy");
    const codex = await connect(hive, "codex@duy");
    await claude.callTool({ name: "memory_write", arguments: { kind: "decision", content: "API dùng tRPC" } });
    const hits = JSON.parse(text(await codex.callTool({ name: "memory_search", arguments: { query: "trpc" } })));
    assert.deepEqual(hits.map((h: { content: string }) => h.content), ["API dùng tRPC"]);
    // Who wrote it and when is bookkeeping: verbose: true for whoever asks about the entry itself.
    const full = JSON.parse(text(await codex.callTool({ name: "memory_search", arguments: { query: "trpc", verbose: true } })));
    assert.equal(full[0].author, "claude@duy");
  });

  it("records team-wide memory with shared: true, and every project's search finds it", async () => {
    const hive = new SqliteHive(":memory:");
    const inApp = await connect(hive, "claude@duy");
    await inApp.callTool({ name: "memory_write", arguments: { shared: true, kind: "convention", content: "Commit theo Conventional Commits" } });
    await inApp.callTool({ name: "memory_write", arguments: { kind: "gotcha", content: "app: chạy migrate trước khi test" } });
    const server = createHiveMcpServer(hive, { name: "codex@duy", role: "agent" }, { defaultProject: "web" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const inWeb = new Client({ name: "test", version: "0" });
    await inWeb.connect(b);
    const hits = JSON.parse(text(await inWeb.callTool({ name: "memory_search", arguments: { verbose: true } }))) as Array<{ project: string | null; content: string }>;
    assert.deepEqual(hits.map((h) => [h.project, h.content]), [[null, "Commit theo Conventional Commits"]], "web sees the shared entry, not app's");
  });

  it("shows agents a doc's images as images and its text files as text", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" } as const;
    await hive.call("docs.save", { key: "org/arch", content: "![Sơ đồ](assets/arch/overview.png)" }, admin);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]).toString("base64");
    await hive.call("docs.assetPut", { key: "org/arch", name: "overview.png", data: png }, admin);
    await hive.call("docs.assetPut", { key: "org/arch", name: "notes.md", data: Buffer.from("# Ghi chú").toString("base64") }, admin);
    const client = await connect(hive);
    const img = await client.callTool({ name: "doc_asset", arguments: { key: "org/arch", name: "overview.png" } });
    assert.deepEqual(img.content, [{ type: "image", data: png, mimeType: "image/png" }]);
    assert.equal(text(await client.callTool({ name: "doc_asset", arguments: { key: "org/arch", name: "notes.md" } })), "# Ghi chú");
    const list = JSON.parse(text(await client.callTool({ name: "doc_asset", arguments: { key: "org/arch" } }))) as Array<{ name: string }>;
    assert.deepEqual(list.map((a) => a.name), ["notes.md", "overview.png"]);
    assert.equal((await client.callTool({ name: "doc_asset", arguments: { key: "org/arch", name: "x.png" } })).isError, true);
  });

  // Roadmap 41c: what earlier runs made is there for the next agent, the pictures as pictures.
  it("lists and reads the files runs made", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" } as const;
    const machine = { name: "runner.mac-mini-1", role: "agent" } as const;
    await hive.call("tasks.create", { id: "APP-1", project: "app", title: "Việc đầu" }, admin);
    await hive.call("tasks.create", { id: "APP-2", project: "app", title: "Việc sau" }, admin);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]).toString("base64");
    const shot = await hive.call("artifacts.put", { project: "app", taskId: "APP-1", runId: "R-1", name: "shots/board.png", data: png }, machine);
    const report = await hive.call("artifacts.put", { project: "app", taskId: "APP-1", runId: "R-1", name: "report.md", data: Buffer.from("# Đo được").toString("base64") }, machine);
    await hive.call("artifacts.put", { project: "app", taskId: "APP-2", runId: "R-2", name: "other.md", data: Buffer.from("# Việc khác").toString("base64") }, machine);

    const client = await connect(hive);
    const all = JSON.parse(text(await client.callTool({ name: "artifact_list", arguments: {} }))) as Array<{ name: string }>;
    assert.deepEqual(all.map((a) => a.name).sort(), ["other.md", "report.md", "shots/board.png"]);
    const mine = JSON.parse(text(await client.callTool({ name: "artifact_list", arguments: { taskId: "APP-1" } }))) as Array<{ id: number; name: string }>;
    assert.deepEqual(mine.map((a) => a.name).sort(), ["report.md", "shots/board.png"]);
    assert.deepEqual((await client.callTool({ name: "artifact_get", arguments: { id: shot.id } })).content, [{ type: "image", data: png, mimeType: "image/png" }]);
    assert.equal(text(await client.callTool({ name: "artifact_get", arguments: { id: report.id } })), "# Đo được");
    assert.equal((await client.callTool({ name: "artifact_get", arguments: { id: 999 } })).isError, true);
  });

  it("lets agents propose but not overwrite docs", async () => {
    const hive = new SqliteHive(":memory:");
    hive.seed();
    const client = await connect(hive);
    const doc = JSON.parse(text(await client.callTool({ name: "doc_get", arguments: { key: "org/agent-protocol" } })));
    const res = await client.callTool({
      name: "doc_propose",
      arguments: { key: doc.key, baseVersion: doc.version, content: `${doc.content}\n7. Test trước khi review.`, reason: "add rule 7" },
    });
    assert.equal(res.isError, undefined);
    assert.equal(JSON.parse(text(res)).status, "pending");

    const stale = await client.callTool({
      name: "doc_propose",
      arguments: { key: doc.key, baseVersion: 0, content: "x", reason: "stale" },
    });
    assert.equal(stale.isError, true);
    assert.match(text(stale), /^conflict:/);
  });

  it("reads the runs and machines the hub heard about", async () => {
    const hive = new SqliteHive(":memory:");
    const mbp = { name: "runner.duy-mbp@duy-mbp", role: "agent" as const };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true }, mbp);
    const at = "2026-09-29T10:00:00.000Z";
    await hive.call(
      "runs.push",
      {
        machine: "duy-mbp",
        runs: [{ runId: "R-1fa9c0", project: "app", taskId: "T-2", taskTitle: "Lockout", role: "review", status: "succeeded", profileId: "claude-1", summary: "Needs fixes: reset the counter.", log: "▶ Read lockout.ts\n✓ read", createdAt: at }],
      },
      mbp,
    );
    const claude = await connect(hive, "claude-1.duy-mbp@chat-lan");
    const [listed] = JSON.parse(text(await claude.callTool({ name: "run_list", arguments: {} })));
    assert.deepEqual([listed.runId, listed.role, listed.summary, listed.machineId], ["R-1fa9c0", "review", "Needs fixes: reset the counter.", mbp.name]);
    const read = JSON.parse(text(await claude.callTool({ name: "run_get", arguments: { machineId: mbp.name, runId: "R-1fa9c0" } })));
    assert.match(read.log, /Read lockout\.ts/);
    const [machine] = JSON.parse(text(await claude.callTool({ name: "machine_list", arguments: {} })));
    assert.deepEqual([machine.machine, machine.acceptsRuns, machine.projects], ["duy-mbp", true, ["app"]]);
  });

  it("reads a project's costs, caps, run requests, policy and missing setup, and nothing of a project it does not see", async () => {
    // Local noon: the day's cap starts at the hub's local midnight, and the run ended an hour before.
    const noon = new Date(2026, 9, 1, 12, 0);
    const hive = new SqliteHive(":memory:", { now: () => noon });
    const admin = { name: "duy", role: "admin" as const };
    const mbp = { name: "runner.duy-mbp@duy-mbp", role: "agent" as const };
    const finishedAt = new Date(noon.getTime() - 60 * 60_000).toISOString();
    const cost = (runId: string, project: string, costUsd: number) => ({ runId, project, taskId: "T-1", profileId: "claude-1", account: null, costUsd, inputTokens: 10, outputTokens: 1, finishedAt });
    const setup = {
      checkedAt: noon.toISOString(),
      report: {
        machine: [{ id: "cli:codex", label: "Codex CLI", state: "missing", detail: "Chưa cài", action: "Cài bằng npm" }],
        projects: [
          { project: "app", repo: "/Users/duy/app", items: [{ id: "app:codegraph-index", label: "Index", state: "missing", detail: "Chưa tạo", action: "Tạo index" }] },
          { project: "site", repo: "/Users/duy/site", items: [{ id: "site:agents", label: "AGENTS.md", state: "missing", detail: "Chưa có", action: "Tạo" }] },
        ],
      },
    };
    await hive.call(
      "machines.heartbeat",
      { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app", "site"], acceptsRuns: true, setup, costs: [cost("R-1", "app", 2), cost("R-2", "site", 5)] } as never,
      mbp,
    );
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "API" }, admin);
    await hive.call("tasks.create", { id: "S-1", project: "site", title: "Home" }, admin);
    await hive.call("runs.dispatch", { machineId: mbp.name, project: "app", taskId: "T-1" }, admin);
    await hive.call("runs.dispatch", { machineId: mbp.name, project: "site", taskId: "S-1" }, admin);
    await hive.call(
      "budgets.set",
      {
        budgets: [
          { scope: { kind: "project", project: "app" }, period: "day", limit: { usd: 10 } },
          { scope: { kind: "project", project: "site" }, period: "day", limit: { usd: 10 } },
          { scope: { kind: "hub" }, period: "month", limit: { runs: 50 } },
        ],
      },
      admin,
    );
    await hive.call("agentPolicy.set", { project: "app", policy: { autonomy: "propose" } }, admin);
    await hive.call("agentPolicy.set", { project: "site", policy: { autonomy: "read" } }, admin);
    await hive.call("policy.set", { projects: { app: ["agents"], site: ["codegraph-index"] } }, admin);
    await hive.call("agents.stop", { project: "site" }, admin);

    // A leader whose sender only has app: what it reads is app's, and site answers not_found like on the web.
    const lan = await connectAs(hive, { name: "claude-1.duy-mbp@chat-lan", role: "agent", chatReply: 1, access: { projects: { app: "member" } } });
    assert.match(lan.getInstructions() ?? "", /cost_summary/);
    const costs = JSON.parse(text(await lan.callTool({ name: "cost_summary", arguments: {} })));
    assert.deepEqual([costs.project, costs.costs.usd1, costs.costs.runs30], ["app", 2, 1]);
    assert.deepEqual(costs.budgets.map((b: { id: string; used: { usd: number } }) => [b.id, b.used.usd]), [["project:app:day", 2]], "neither site's cap nor the hub's");
    const requests = JSON.parse(text(await lan.callTool({ name: "run_requests", arguments: {} })));
    assert.deepEqual(requests.map((r: { project: string; taskId: string; status: string }) => [r.project, r.taskId, r.status]), [["app", "T-1", "pending"]]);
    const policy = JSON.parse(text(await lan.callTool({ name: "policy_get", arguments: {} })));
    assert.deepEqual(
      [policy.agentPolicy.effective.autonomy, policy.agentPolicy.project, policy.required.repo, policy.paused],
      ["propose", { autonomy: "propose" }, ["agents"], { hub: null, project: null }],
    );
    assert.equal(JSON.stringify(policy).includes("site"), false, "nothing of site in app's answer");
    const missing = JSON.parse(text(await lan.callTool({ name: "setup_missing", arguments: {} })));
    assert.deepEqual(missing.map((m: { machine: string; items: Array<{ id: string }> }) => [m.machine, m.items.map((i) => i.id)]), [["duy-mbp", ["cli:codex", "app:codegraph-index"]]]);
    assert.equal(JSON.stringify(missing).includes("action"), false);
    for (const name of ["cost_summary", "run_requests", "policy_get", "setup_missing"]) {
      const other = await lan.callTool({ name, arguments: { project: "site" } });
      assert.equal(other.isError, true, name);
      assert.match(text(other), /^not_found/, name);
    }

    // A hub admin sees the hub's cap too, and that site's agents are stopped.
    const duy = await connectAs(hive, admin);
    const all = JSON.parse(text(await duy.callTool({ name: "cost_summary", arguments: {} })));
    assert.deepEqual(all.budgets.map((b: { id: string }) => b.id).sort(), ["hub:month", "project:app:day"]);
    const site = JSON.parse(text(await duy.callTool({ name: "policy_get", arguments: { project: "site" } })));
    assert.deepEqual([site.agentPolicy.effective.autonomy, site.paused.hub, site.paused.project?.name], ["read", null, "duy"]);
  });

  it("shows the hub's open alerts to hub admins only, and only when the hub hands them over", async () => {
    const hive = new SqliteHive(":memory:");
    const open = [
      { id: 1, rule: "machine_offline", project: null },
      { id: 2, rule: "run_fail_streak", project: "app" },
      { id: 3, rule: "run_fail_streak", project: "site" },
    ];
    const alerts = { list: async () => open };
    const has = async (client: Client) => (await client.listTools()).tools.some((t) => t.name === "alert_list");

    const admin = await connectAs(hive, { name: "duy", role: "admin" }, { alerts });
    assert.equal(await has(admin), true);
    assert.equal(JSON.parse(text(await admin.callTool({ name: "alert_list", arguments: {} }))).length, 3);
    const app = JSON.parse(text(await admin.callTool({ name: "alert_list", arguments: { project: "app" } })));
    assert.deepEqual(app.map((a: { id: number }) => a.id), [1, 2], "the project's and the hub-wide ones");

    assert.equal(await has(await connectAs(hive, { name: "duy", role: "admin" })), false, "no alerts handed over");
    assert.equal(await has(await connectAs(hive, { name: "lan", role: "admin", access: { projects: { app: "lead" } } }, { alerts })), false, "an admin of some projects only");
    assert.equal(await has(await connectAs(hive, { name: "claude@duy", role: "agent" }, { alerts })), false);
    assert.equal(await has(await connectAs(hive, { name: "ci", role: "viewer" }, { alerts })), false);
  });

  it("gives a chat leader the propose tools for the rest of the web, and nobody else", async () => {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const mbp = { name: "runner.duy-mbp@duy-mbp", role: "agent" as const };
    // A Claude plan: the chat's replies are written with one.
    const claude = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, cooldownUntil: null, runs: 0, rateLimited: 0 };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app"], acceptsRuns: true, profiles: [claude] }, mbp);
    await hive.call(
      "runs.push",
      { machine: "duy-mbp", runs: [{ runId: "R-1fa9c0", project: "app", taskId: "T-2", taskTitle: "Lockout", role: "implement", status: "running", profileId: "claude-1", createdAt: "2026-09-29T10:00:00.000Z" }] },
      mbp,
    );
    const sent = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Stop the lockout run" }, admin);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "Looking" }, mbp);
    const server = createHiveMcpServer(hive, { name: "claude-1.duy-mbp@chat-duy", role: "agent", access: { projects: { app: "contribute" } }, chatReply: sent.reply.id }, { defaultProject: "app" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const leader = new Client({ name: "test", version: "0" });
    await leader.connect(b);

    const added = ["propose_research", "propose_plan", "propose_cancel_run", "propose_install", "propose_merge", "propose_policy", "propose_profile", "propose_resume_agents", "propose_stop_agents", "propose_task_agent", "propose_tool"];
    const tools = (await leader.listTools()).tools.map((t) => t.name);
    for (const name of added) assert.ok(tools.includes(name), name);
    for (const name of added) assert.match(leader.getInstructions() ?? "", new RegExp(name));
    const agent = await connect(hive, "claude@duy");
    const agentTools = (await agent.listTools()).tools.map((t) => t.name);
    assert.deepEqual(added.filter((name) => agentTools.includes(name)), [], "not for an agent working a task");

    const cancel = JSON.parse(text(await leader.callTool({ name: "propose_cancel_run", arguments: { machine: "duy-mbp", runId: "R-1fa9c0", reason: "Asked to stop it" } })));
    assert.deepEqual([cancel.kind, cancel.status, cancel.project, cancel.input], ["run.cancel", "proposed", "app", { machineId: mbp.name, runId: "R-1fa9c0" }]);
    const policy = JSON.parse(text(await leader.callTool({ name: "propose_policy", arguments: { policy: { autonomy: "propose" }, reason: "Tighter" } })));
    assert.deepEqual(policy.input, { project: "app", policy: { autonomy: "propose" }, before: null });
    const stop = JSON.parse(text(await leader.callTool({ name: "propose_stop_agents", arguments: { reason: "Everything is off" } })));
    assert.deepEqual(stop.input, { project: "app" });
    const refused = await leader.callTool({ name: "propose_merge", arguments: { machine: "duy-mbp", runId: "R-1fa9c0", reason: "Ship it" } });
    assert.ok(refused.isError);
    assert.match(text(refused), /no merge request/);
    // Roadmap 28e: a catalog tool for the chat's project; required left out keeps what the project has.
    const tool = JSON.parse(text(await leader.callTool({ name: "propose_tool", arguments: { id: "codegraph", enabled: true, reason: "Faster lookups" } })));
    assert.deepEqual([tool.kind, tool.status, tool.input], [
      "tool.enable",
      "proposed",
      { id: "codegraph", project: "app", enabled: true, required: false, name: "Codegraph", before: { enabled: null, required: false, effective: false } },
    ]);
    const unknown = await leader.callTool({ name: "propose_tool", arguments: { id: "nope", enabled: true, reason: "x" } });
    assert.ok(unknown.isError);
    assert.match(text(unknown), /^not_found/);
    // Roadmap 50: "give it to duy-mbp" is an assignment, which the hub then starts by itself.
    await hive.call("tasks.create", { id: "T-2", project: "app", title: "Lockout" }, admin);
    const assign = JSON.parse(text(await leader.callTool({ name: "propose_task_agent", arguments: { taskId: "T-2", machine: "duy-mbp", reason: "Its repo is there" } })));
    assert.deepEqual([assign.kind, assign.status, assign.input.id, assign.input.machineId, assign.input.profileId], ["task.assign", "proposed", "T-2", mbp.name, null]);
    // Roadmap 60d: a whole plan in one proposal, its tasks on the chat's project unless one names another.
    const plan = JSON.parse(text(await leader.callTool({
      name: "propose_plan",
      arguments: {
        spec: { key: "project/app/lockout", title: "Lockout", content: "# Lockout" },
        tasks: [{ id: "T-3", title: "Unlock after an hour", acceptance: "A locked account signs in again after an hour", dependsOn: ["T-2"] }],
        batches: [{ title: "One", taskIds: ["T-3"] }],
        reason: "Asked to fix the lockout",
      },
    })));
    assert.deepEqual([plan.kind, plan.status, plan.project, plan.input.tasks[0].project], ["plan.create", "proposed", "app", "app"]);
    const research = JSON.parse(text(await leader.callTool({ name: "propose_research", arguments: { topic: "Storage", questions: ["Which option?"], sources: ["repo", "hive"], reason: "Read first" } })));
    assert.deepEqual([research.kind, research.status, research.input.scope, research.input.format, research.input.machineId], ["research.start", "proposed", "service", "brief", mbp.name]);
    // Roadmap 54b: what a task is, proposed like the rest; confirming sets it as the person who confirmed.
    assert.ok(tools.includes("propose_task_classify"));
    assert.match(leader.getInstructions() ?? "", /propose_task_classify/);
    const kind = JSON.parse(text(await leader.callTool({ name: "propose_task_classify", arguments: { id: "T-2", taskKind: "debug", size: "s", reason: "Lockout cause unknown" } })));
    assert.deepEqual([kind.kind, kind.status, kind.input], ["task.classify", "proposed", { id: "T-2", taskKind: "debug", size: "s" }]);
    await hive.call("chat.decide", { actionId: kind.id, accept: true }, admin);
    const t2 = (await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === "T-2")!;
    assert.deepEqual([t2.kind, t2.size, t2.classifiedBy], ["debug", "s", "duy"]);
    const empty = await leader.callTool({ name: "propose_task_classify", arguments: { id: "T-2", reason: "Nothing" } });
    assert.ok(empty.isError);
  });

  it("reads the catalog, where its tools stand and what runs used, for the project only (roadmap 28e)", async () => {
    const hive = new SqliteHive(":memory:", { now: () => new Date("2026-10-02T04:00:00.000Z") });
    const admin = { name: "duy", role: "admin" as const };
    const mbp = { name: "runner.duy-mbp@duy-mbp", role: "agent" as const };
    const item = (id: string, state: "installed" | "missing") => ({ id, label: id, state, detail: "", action: null });
    const run = (runId: string, project: string) => ({ runId, project, taskId: "T-1", taskTitle: "x", role: "implement" as const, status: "succeeded" as const, profileId: "claude-1", createdAt: "2026-10-02T02:00:00.000Z" });
    const cost = (runId: string, project: string) => ({
      runId,
      project,
      taskId: "T-1",
      profileId: "claude-1",
      account: null,
      costUsd: 0.5,
      inputTokens: 1000,
      cacheWriteTokens: 1000,
      cacheReadTokens: 8000,
      outputTokens: 400,
      finishedAt: "2026-10-02T03:00:00.000Z",
    });
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run("R-a1", "app"), run("R-s1", "site")] }, mbp);
    await hive.call(
      "machines.heartbeat",
      {
        machine: "duy-mbp",
        instance: "a1b2c3d4",
        projects: ["app", "site"],
        setup: {
          checkedAt: "2026-10-02T03:00:00.000Z",
          report: { machine: [item("cli:specify", "installed")], projects: [{ project: "app", repo: "/r/app", items: [item("app:codegraph-mcp", "missing")] }] },
        },
        costs: [cost("R-a1", "app"), cost("R-s1", "site")],
      },
      mbp,
    );
    await hive.call("tools.setProject", { id: "codegraph", project: "app", enabled: true, required: false }, admin);
    await hive.call("tools.setProject", { id: "speckit", project: "site", enabled: true, required: false }, admin);

    const lan = await connectAs(hive, { name: "claude-1.duy-mbp@chat-lan", role: "agent", chatReply: 1, access: { projects: { app: "member" } } });
    for (const name of ["tool_list", "tool_status", "token_usage"]) assert.match(lan.getInstructions() ?? "", new RegExp(name));
    const list = JSON.parse(text(await lan.callTool({ name: "tool_list", arguments: {} })));
    assert.deepEqual(
      list.map((t: { id: string; projects: Array<{ project: string; effective: boolean }> }) => [t.id, t.projects.map((p) => [p.project, p.effective])]),
      [["browser", [["app", false]]], ["codegraph", [["app", true]]], ["speckit", [["app", false]]], ["superpowers", [["app", false]]], ["kilo-cli", [["app", false]]], ["rtk", [["app", false]]]],
      "app's line alone: site turned speckit on, which is not app's to read",
    );
    const status = JSON.parse(text(await lan.callTool({ name: "tool_status", arguments: {} })));
    const codegraph = status.find((s: { id: string }) => s.id === "codegraph");
    assert.deepEqual(
      [codegraph.effective, codegraph.machines.map((m: { machine: string; items: Array<{ id: string; state: string }> }) => [m.machine, m.items.map((i) => [i.id, i.state])])],
      [true, [["duy-mbp", [["app:codegraph-mcp", "missing"]]]]],
    );
    const usage = JSON.parse(text(await lan.callTool({ name: "token_usage", arguments: {} })));
    assert.deepEqual([usage.project, usage.last30.runs, usage.last30.cacheReadTokens, usage.last30.cacheReadShare], ["app", 1, 8000, 0.8]);
    assert.deepEqual(usage.runs.map((r: { runId: string; cacheReadShare: number }) => [r.runId, r.cacheReadShare]), [["R-a1", 0.8]]);
    for (const name of ["tool_list", "tool_status", "token_usage"]) {
      const other = await lan.callTool({ name, arguments: { project: "site" } });
      assert.equal(other.isError, true, name);
      assert.match(text(other), /^not_found/, name);
    }
  });

  /** A hub with two projects, a task and a run each, one machine with both repos, and a system over them. */
  async function hubWide() {
    const hive = new SqliteHive(":memory:");
    const admin = { name: "duy", role: "admin" as const };
    const mbp = { name: "runner.duy-mbp@duy-mbp", role: "agent" as const };
    const claude = { id: "claude-1", label: "Claude", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 };
    await hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "a1b2c3d4", projects: ["app", "site"], acceptsRuns: true, profiles: [claude] }, mbp);
    await hive.call("tasks.create", { id: "T-1", project: "app", title: "Sign in" }, admin);
    await hive.call("tasks.create", { id: "T-2", project: "app", title: "Reset", dependsOn: ["T-1"] }, admin);
    await hive.call("tasks.update", { id: "T-1", status: "doing" }, admin);
    await hive.call("tasks.create", { id: "S-1", project: "site", title: "Landing" }, admin);
    await hive.call("systems.save", { name: "shop", projects: ["app", "site"] }, admin);
    const run = (runId: string, project: string, taskId: string, status: "running" | "succeeded") => ({
      runId,
      project,
      taskId,
      taskTitle: "x",
      role: "implement" as const,
      status,
      profileId: "claude-1",
      createdAt: "2026-09-29T07:50:00.000Z",
    });
    await hive.call("runs.push", { machine: "duy-mbp", runs: [run("R-app1", "app", "T-1", "running"), run("R-site1", "site", "S-1", "succeeded")] }, mbp);
    // The reply the hub-wide leader writes; its token is cut from the machine's, so it is never a hub admin itself.
    const sent = await hive.call("chat.send", { project: "*", machineId: mbp.name, text: "Tidy up every project" }, admin);
    await hive.call("chat.progress", { replyId: sent.reply.id, text: "Looking" }, mbp);
    const leader: Actor = { name: "claude-1.duy-mbp@chat-duy", role: "agent", chatReply: sent.reply.id };
    return { hive, admin, leader };
  }

  it("gives the hub-wide leader every project, no default project, and reads over the whole hub (roadmap 37)", async () => {
    const { hive, admin, leader } = await hubWide();
    const open = [{ id: 1, rule: "machine.offline", project: "app" }, { id: 2, rule: "budget.over", project: null }];
    const client = await connectHubLeader(hive, leader, { alerts: { list: async () => open } });

    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /project_list/);
    assert.match(instructions, /no default project/);

    const projects = JSON.parse(text(await client.callTool({ name: "project_list", arguments: {} })));
    assert.deepEqual(
      projects.map((p: { project: string; systems: string[] }) => [p.project, p.systems]),
      [["app", ["shop"]], ["site", ["shop"]]],
    );
    const app = projects.find((p: { project: string }) => p.project === "app");
    assert.deepEqual([app.tasks.todo, app.tasks.doing, app.runs.running], [1, 1, 1]);
    assert.deepEqual(app.machines.map((m: { machine: string; online: boolean }) => [m.machine, m.online]), [["duy-mbp", true]]);

    // No project and no default: the reads that can answer for the whole hub do.
    const runs = JSON.parse(text(await client.callTool({ name: "run_list", arguments: {} })));
    assert.deepEqual(runs.map((r: { runId: string }) => r.runId).sort(), ["R-app1", "R-site1"]);
    assert.deepEqual(JSON.parse(text(await client.callTool({ name: "run_list", arguments: { project: "site" } }))).map((r: { runId: string }) => r.runId), ["R-site1"]);
    assert.deepEqual(JSON.parse(text(await client.callTool({ name: "run_count", arguments: {} }))), await hive.call("runs.count", {}, admin));
    assert.deepEqual(JSON.parse(text(await client.callTool({ name: "run_count", arguments: { project: "site" } }))), await hive.call("runs.count", { project: "site" }, admin));
    const costs = JSON.parse(text(await client.callTool({ name: "cost_summary", arguments: {} })));
    assert.equal(costs.project, null, "the whole hub, with every project's line");
    assert.equal(JSON.parse(text(await client.callTool({ name: "run_requests", arguments: {} }))).length, 0);
    assert.equal(JSON.parse(text(await client.callTool({ name: "alert_list", arguments: {} }))).length, 2, "a hub-wide chat is a hub admin's: it sees the alerts");
    assert.equal(JSON.parse(text(await client.callTool({ name: "machine_list", arguments: {} }))).length, 1);

    // The rest need one named, and say so rather than guessing.
    for (const name of ["task_list", "task_next", "tool_list", "tool_status", "policy_get", "setup_missing", "token_usage", "memory_search"]) {
      const refused = await client.callTool({ name, arguments: {} });
      assert.equal(refused.isError, true, name);
      assert.match(text(refused), /project is required: this chat is the whole hub/, name);
    }
    assert.deepEqual(JSON.parse(text(await client.callTool({ name: "task_list", arguments: { project: "app" } }))).map((t: { id: string }) => t.id).sort(), ["T-1", "T-2"]);
  });

  it("uses the complete project inventory and keeps hub reads separate from mutation grants", async () => {
    const { hive, admin, leader } = await hubWide();
    await hive.call("docs.save", { key: "project/docs-only/agents", content: "Docs only" }, admin);
    await hive.call("tasks.create", { id: "P-1", project: "private", title: "Outside machine grants" }, admin);
    const restricted: Actor = { ...leader, access: { projects: { app: "contribute" } } };
    const client = await connectHubLeader(hive, restricted, {
      defaultProject: "app",
      alerts: { list: async () => [{ project: "private" }, { project: null }] },
    });
    const projects = JSON.parse(text(await client.callTool({ name: "project_list", arguments: {} })));
    assert.deepEqual(projects.map((p: { project: string }) => p.project), ["app", "docs-only", "private", "site"]);
    assert.equal((await client.callTool({ name: "task_list", arguments: {} })).isError, true);
    const runs = JSON.parse(text(await client.callTool({ name: "run_list", arguments: {} })));
    assert.deepEqual(runs.map((r: { project: string }) => r.project).sort(), ["app", "site"]);
    assert.equal(JSON.parse(text(await client.callTool({ name: "alert_list", arguments: {} }))).length, 2);
    const refused = await client.callTool({ name: "propose_task", arguments: { id: "P-2", title: "No wider mutation", project: "private", reason: "Check grants" } });
    assert.equal(refused.isError, true);
    assert.equal((await client.listTools()).tools.some((t) => t.name === "task_update"), false);
    await client.close();
    const regular = await connectAs(hive, restricted);
    const visible = JSON.parse(text(await regular.callTool({ name: "project_list", arguments: {} })));
    assert.deepEqual(visible.map((p: { project: string }) => p.project), ["app"]);
    await regular.close();
  });

  it("makes the hub-wide leader name the project it proposes for, except for what belongs to no project", async () => {
    const { hive, admin, leader } = await hubWide();
    const client = await connectHubLeader(hive, leader);

    const needsProject = await client.callTool({ name: "propose_task", arguments: { id: "T-9", title: "Reset page", reason: "Asked in the chat" } });
    assert.equal(needsProject.isError, true, "project is required at hub scope");
    const made = JSON.parse(text(await client.callTool({ name: "propose_task", arguments: { id: "T-9", title: "Reset page", project: "app", platforms: ["windows"], reason: "Asked in the chat" } })));
    assert.deepEqual([made.project, made.status, made.input.project, made.input.platforms], ["app", "proposed", "app", ["windows"]]);
    const moved = JSON.parse(text(await client.callTool({ name: "propose_task_status", arguments: { id: "S-1", status: "doing", project: "site", reason: "Started" } })));
    assert.equal(moved.project, "site");
    const unknown = await client.callTool({ name: "propose_task_status", arguments: { id: "S-1", status: "doing", project: "ghost", reason: "x" } });
    assert.ok(unknown.isError);
    assert.match(text(unknown), /^not_found/);

    // A plan is the machine's and needs no project; stopping agents without one means the whole hub.
    const plan = JSON.parse(text(await client.callTool({ name: "propose_profile", arguments: { machine: "duy-mbp", profileId: "claude-1", enabled: false, reason: "Resting" } })));
    assert.equal(plan.project, "*");
    const stopAll = JSON.parse(text(await client.callTool({ name: "propose_stop_agents", arguments: { reason: "Everything off" } })));
    assert.deepEqual([stopAll.project, stopAll.input], ["*", { project: null }]);
    const stopApp = JSON.parse(text(await client.callTool({ name: "propose_stop_agents", arguments: { project: "app", reason: "app only" } })));
    assert.deepEqual([stopApp.project, stopApp.input], ["app", { project: "app" }]);

    // Only a hub admin confirms, and it then runs as them.
    const decided = await hive.call("chat.decide", { actionId: made.id, accept: true }, admin);
    assert.deepEqual([decided.status, decided.result], ["done", { taskId: "T-9" }]);
    assert.deepEqual((await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === "T-9")?.platforms, ["windows"]);
  });

  it("keeps a project chat's leader working the way it did before roadmap 37", async () => {
    const { hive, admin } = await hubWide();
    const mbp = { name: "runner.duy-mbp@duy-mbp", role: "agent" as const };
    const app = await hive.call("chat.send", { project: "app", machineId: mbp.name, text: "Plan the reset page" }, admin);
    await hive.call("chat.progress", { replyId: app.reply.id, text: "Looking" }, mbp);
    const client = await connectAs(hive, { name: "claude-1.duy-mbp@chat-duy", role: "agent", chatReply: app.reply.id });

    // The default project stands in for the missing argument, and nothing asks which project.
    assert.deepEqual(JSON.parse(text(await client.callTool({ name: "run_list", arguments: {} }))).map((r: { runId: string }) => r.runId), ["R-app1"]);
    assert.deepEqual(JSON.parse(text(await client.callTool({ name: "run_count", arguments: {} }))), { running: 1, queued: 0 });
    assert.equal(JSON.parse(text(await client.callTool({ name: "cost_summary", arguments: {} }))).project, "app");
    assert.doesNotMatch(client.getInstructions() ?? "", /no default project/);
    const proposed = JSON.parse(text(await client.callTool({ name: "propose_task", arguments: { id: "T-9", title: "Reset page", reason: "Asked in the chat" } })));
    assert.deepEqual([proposed.project, proposed.input.project], ["app", "app"], "the chat's project, not named");
    const stop = JSON.parse(text(await client.callTool({ name: "propose_stop_agents", arguments: { reason: "Pause app" } })));
    assert.deepEqual([stop.project, stop.input], ["app", { project: "app" }], "never the whole hub from a project's chat");
  });
});

async function connectAs(hive: SqliteHive, actor: Actor, opts: HiveMcpOptions = {}) {
  const server = createHiveMcpServer(hive, actor, { defaultProject: "app", ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

/** The leader of a hub-wide chat (roadmap 37): no default project, and the hub's alerts. */
async function connectHubLeader(hive: SqliteHive, actor: Actor, opts: HiveMcpOptions = {}) {
  const server = createHiveMcpServer(hive, actor, { hubScope: true, ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}
