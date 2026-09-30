import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "#mcp/index.ts";

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
  it("exposes the agent tool set", async () => {
    const client = await connect(new SqliteHive(":memory:"));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "doc_asset",
      "doc_get",
      "doc_list",
      "doc_propose",
      "machine_list",
      "memory_search",
      "memory_write",
      "run_get",
      "run_list",
      "skill_get",
      "skill_list",
      "skill_propose",
      "task_claim",
      "task_list",
      "task_next",
      "task_update",
    ]);
  });

  it("gives read-only agents and viewer tokens the read tools only", async () => {
    const hive = new SqliteHive(":memory:");
    for (const client of [await connect(hive, "claude@duy", { readOnly: true }), await connect(hive, "ci", { role: "viewer" })]) {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
        "doc_asset",
        "doc_get",
        "doc_list",
        "machine_list",
        "memory_search",
        "run_get",
        "run_list",
        "skill_get",
        "skill_list",
        "task_list",
        "task_next",
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

  it("shares memory between two agents", async () => {
    const hive = new SqliteHive(":memory:");
    const claude = await connect(hive, "claude@duy");
    const codex = await connect(hive, "codex@duy");
    await claude.callTool({ name: "memory_write", arguments: { kind: "decision", content: "API dùng tRPC" } });
    const res = await codex.callTool({ name: "memory_search", arguments: { query: "trpc" } });
    const hits = JSON.parse(text(res));
    assert.equal(hits[0].author, "claude@duy");
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
    const hits = JSON.parse(text(await inWeb.callTool({ name: "memory_search", arguments: {} }))) as Array<{ project: string | null; content: string }>;
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
});
