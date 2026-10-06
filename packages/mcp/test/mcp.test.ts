import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Actor } from "@xdev-hive/core";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHiveMcpServer, type HiveMcpOptions } from "#mcp/index.ts";

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
      "cost_summary",
      "doc_asset",
      "doc_get",
      "doc_list",
      "doc_propose",
      "machine_list",
      "memory_search",
      "memory_write",
      "policy_get",
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
      "task_update",
      "token_usage",
      "tool_list",
      "tool_status",
    ]);
  });

  it("gives read-only agents and viewer tokens the read tools only", async () => {
    const hive = new SqliteHive(":memory:");
    for (const client of [await connect(hive, "claude@duy", { readOnly: true }), await connect(hive, "ci", { role: "viewer" })]) {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
        "cost_summary",
        "doc_asset",
        "doc_get",
        "doc_list",
        "machine_list",
        "memory_search",
        "policy_get",
        "run_get",
        "run_list",
        "run_requests",
        "setup_missing",
        "skill_get",
        "skill_list",
        "task_get",
        "task_list",
        "task_next",
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

    const added = ["propose_cancel_run", "propose_install", "propose_merge", "propose_policy", "propose_profile", "propose_resume_agents", "propose_stop_agents", "propose_task_agent", "propose_tool"];
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
      [["codegraph", [["app", true]]], ["speckit", [["app", false]]], ["superpowers", [["app", false]]], ["rtk", [["app", false]]]],
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
});

async function connectAs(hive: SqliteHive, actor: Actor, opts: HiveMcpOptions = {}) {
  const server = createHiveMcpServer(hive, actor, { defaultProject: "app", ...opts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}
