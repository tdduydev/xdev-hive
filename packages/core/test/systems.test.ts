import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, memberPath, parseSystemSource, systemFolders, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
/** Manages web and api, only views app, and does not see billing. */
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "view", web: "manage", api: "manage" } } };
const lanAgent: Actor = { name: "claude.lan-mbp@lan-mbp", role: "agent", access: lan.access };

async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.code;
  }
  assert.fail("expected the call to fail");
}

const run = (runId: string, project: string) => ({
  runId,
  project,
  taskId: `${project}-1`,
  taskTitle: `${project} task`,
  role: "implement" as const,
  status: "succeeded" as const,
  profileId: "claude-1",
  activity: null,
  log: "",
  createdAt: "2026-09-30T04:00:00.000Z",
});

async function hub() {
  const hive = new SqliteHive(":memory:", { now: () => new Date("2026-09-30T08:00:00.000Z") });
  hive.seed("hub");
  for (const p of ["app", "web", "api", "billing"]) {
    await hive.call("memory.write", { project: p, kind: "gotcha", content: `${p} gotcha` }, admin);
    await hive.call("tasks.create", { id: `${p}-1`, project: p, title: `${p} task` }, admin);
  }
  await hive.call("memory.write", { shared: true, kind: "convention", content: "shared convention" }, admin);
  await hive.call("runs.push", { machine: "duy-mbp", runs: ["app", "web", "api", "billing"].map((p, i) => run(`R-00000${i}`, p)) }, machine);
  return hive;
}

describe("systems", () => {
  it("groups projects under a name, replaced as a whole, and removed", async () => {
    const hive = await hub();
    const saved = await hive.call("systems.save", { name: "shop", projects: ["web", "app", "web"] }, admin);
    assert.deepEqual([saved.name, saved.projects, saved.updatedBy], ["shop", ["app", "web"], "duy"], "sorted, once each");
    await hive.call("systems.save", { name: "billing", projects: ["billing"] }, admin);
    await hive.call("systems.save", { name: "shop", projects: ["app", "web", "api"] }, admin);
    assert.deepEqual(
      (await hive.call("systems.list", {}, admin)).map((s) => [s.name, s.projects]),
      [["billing", ["billing"]], ["shop", ["api", "app", "web"]]],
    );
    assert.deepEqual(await hive.call("systems.remove", { name: "billing" }, admin), { removed: true });
    assert.deepEqual(await hive.call("systems.remove", { name: "billing" }, admin), { removed: false });
    assert.deepEqual((await hive.call("systems.list", {}, admin)).map((s) => s.name), ["shop"]);
    const audit = await hive.call("admin.audit", {}, admin);
    assert.ok(audit.some((a) => a.action === "systems.save" && a.target === "shop" && a.detail === "api, app, web"));
    assert.ok(audit.some((a) => a.action === "systems.remove" && a.target === "billing"));
    assert.equal(await refusal(hive.call("systems.save", { name: "empty", projects: [] }, admin)), "bad_request");
  });

  it("shows each person only the projects they see, and only who manages every project changes it", async () => {
    const hive = await hub();
    await hive.call("systems.save", { name: "shop", projects: ["app", "web", "billing"] }, admin);
    await hive.call("systems.save", { name: "money", projects: ["billing"] }, admin);
    assert.deepEqual((await hive.call("systems.list", {}, lan)).map((s) => [s.name, s.projects]), [["shop", ["app", "web"]]], "billing and its system hidden");
    // Her own: the projects she manages.
    assert.deepEqual((await hive.call("systems.save", { name: "front", projects: ["web", "api"] }, lan)).projects, ["api", "web"]);
    assert.equal(await refusal(hive.call("systems.save", { name: "front", projects: ["web", "app"] }, lan)), "forbidden", "only views app");
    assert.equal(await refusal(hive.call("systems.save", { name: "x", projects: ["billing"] }, lan)), "not_found");
    // shop has app, which she only views: she may neither drop it nor remove the system.
    assert.equal(await refusal(hive.call("systems.save", { name: "shop", projects: ["web"] }, lan)), "forbidden");
    assert.equal(await refusal(hive.call("systems.remove", { name: "shop" }, lan)), "forbidden");
    // money is billing's, which she does not see: taking it over looks like a project that is not there.
    assert.equal(await refusal(hive.call("systems.save", { name: "money", projects: ["web"] }, lan)), "not_found");
    assert.equal(await refusal(hive.call("systems.remove", { name: "money" }, lan)), "not_found");
    assert.equal(await refusal(hive.call("systems.save", { name: "api-only", projects: ["api"] }, lanAgent)), "forbidden", "agent tokens never manage");
  });

  it("filters tasks, runs, requests, chat and memory by a list of projects", async () => {
    const hive = await hub();
    const ids = (rows: Array<{ project: string | null }>) => rows.map((r) => r.project ?? "chung").sort();
    assert.deepEqual(ids(await hive.call("tasks.list", { projects: ["app", "web"] }, admin)), ["app", "web"]);
    assert.deepEqual(await hive.call("tasks.list", { projects: [] }, admin), [], "none listed: nothing");
    assert.deepEqual(ids(await hive.call("tasks.list", { projects: ["app", "web"] }, lan)), ["app", "web"]);
    assert.deepEqual(ids(await hive.call("tasks.list", { projects: ["app", "billing"] }, lan)), ["app"], "what she cannot see stays out");
    assert.deepEqual(ids(await hive.call("tasks.next", { projects: ["api", "billing"] }, admin)), ["api", "billing"]);
    assert.deepEqual(ids(await hive.call("runs.list", { projects: ["web", "api"] }, admin)), ["api", "web"]);
    assert.deepEqual(ids(await hive.call("memory.list", { projects: ["app", "web"] }, admin)), ["app", "web"]);
    assert.deepEqual(ids(await hive.call("memory.list", { projects: ["app", "web"], includeShared: true }, admin)), ["app", "chung", "web"]);
    assert.deepEqual(ids(await hive.call("memory.search", { projects: ["app", "api"], query: "gotcha" }, admin)), ["api", "app"]);
    assert.deepEqual(ids(await hive.call("memory.search", { projects: ["app"] }, admin)), ["app", "chung"], "shared too, by default");
    assert.deepEqual(ids(await hive.call("memory.search", { projects: ["app"], includeShared: false }, admin)), ["app"]);

    await hive.call(
      "machines.heartbeat",
      {
        machine: "duy-mbp",
        instance: "a1b2c3d4",
        profiles: [{ id: "claude-1", label: "claude-1", kind: "claude", enabled: true, account: null, installed: true, loggedIn: true, cooldownUntil: null, runs: 0, rateLimited: 0 }],
        projects: ["app", "web", "api"],
        acceptsRuns: true,
      },
      machine,
    );
    for (const p of ["app", "web", "api"]) await hive.call("runs.dispatch", { machineId: machine.name, project: p, taskId: `${p}-1` }, admin);
    assert.deepEqual(ids(await hive.call("runs.requests", { projects: ["app", "api"] }, admin)), ["api", "app"]);
    for (const p of ["app", "web", "api"]) await hive.call("chat.send", { project: p, machineId: machine.name, text: `hi ${p}` }, admin);
    assert.deepEqual(ids(await hive.call("chat.threads", { projects: ["web", "api"] }, admin)), ["api", "web"]);
    assert.deepEqual(ids(await hive.call("chat.threads", { projects: [] }, admin)), []);
  });
});

describe("system source (GROUP-init-sync)", () => {
  const member = (project: string, path: string, state: "active" | "archived" | "gone" = "active") => ({
    project,
    pathWithNamespace: `shop/${path}`,
    sshUrl: `git@gitlab.example.com:shop/${path}.git`,
    httpUrl: `https://gitlab.example.com/shop/${path}.git`,
    defaultBranch: "main",
    state,
  });
  const source = (members: ReturnType<typeof member>[]) => ({ forge: "gitlab" as const, url: "https://gitlab.example.com", groupPath: "shop", members, syncedAt: null });

  it("keeps the group and each member's path and clone URLs; a save without one keeps it, null drops it", async () => {
    const hive = await hub();
    const saved = await hive.call("systems.save", { name: "shop", projects: ["app", "web"], source: source([member("app", "mobile/app"), member("web", "web")]) }, admin);
    assert.equal(saved.source?.groupPath, "shop");
    assert.deepEqual(saved.source?.members.map((m) => [m.project, m.pathWithNamespace]), [["app", "shop/mobile/app"], ["web", "shop/web"]]);
    // The editor of the Systems page only sends projects: the source must survive it.
    await hive.call("systems.save", { name: "shop", projects: ["app", "web", "api"] }, admin);
    const [kept] = await hive.call("systems.list", {}, admin);
    assert.deepEqual([kept!.projects, kept!.source?.members.length], [["api", "app", "web"], 2]);
    assert.ok((await hive.call("admin.audit", {}, admin)).some((a) => a.action === "systems.save" && a.detail === "app, web · source gitlab:shop (2)"));
    await hive.call("systems.save", { name: "shop", projects: ["app"], source: null }, admin);
    assert.equal((await hive.call("systems.list", {}, admin))[0]!.source, null);
  });

  it("shows only the members of projects the reader sees, and a member takes the right of its project", async () => {
    const hive = await hub();
    await hive.call("systems.save", { name: "shop", projects: ["app", "web", "billing"], source: source([member("app", "app"), member("web", "web"), member("billing", "billing")]) }, admin);
    const [seen] = await hive.call("systems.list", {}, lan);
    assert.deepEqual(seen!.source?.members.map((m) => m.project), ["app", "web"], "billing's repo stays hidden");
    // A member names where a project is cloned from on every machine: only who manages that project may set it.
    assert.equal(await refusal(hive.call("systems.save", { name: "front", projects: ["web"], source: source([member("web", "web"), member("app", "app")]) }, lan)), "forbidden");
    assert.equal((await hive.call("systems.save", { name: "front", projects: ["web", "api"], source: source([member("web", "web"), member("api", "api")]) }, lan)).source?.members.length, 2);
  });

  it("refuses a source that carries credentials, another transport, or the same repo twice", async () => {
    const hive = await hub();
    const bad = [
      source([{ ...member("app", "app"), httpUrl: "https://oauth2:secret@gitlab.example.com/shop/app.git" }]),
      source([{ ...member("app", "app"), sshUrl: "ext::sh -c touch% /tmp/x" }]),
      source([member("app", "app"), member("web", "app")]),
      { ...source([member("app", "app")]), url: "https://user:pw@gitlab.example.com" },
      { ...source([member("app", "app")]), groupPath: "shop/../other" },
    ];
    for (const s of bad) assert.equal(await refusal(hive.call("systems.save", { name: "shop", projects: ["app"], source: s }, admin)), "bad_request", JSON.stringify(s));
  });

  it("lays the projects out as the group's tree", () => {
    const s = { projects: ["svc-core", "svc-portal", "infa", "login-theme", "loose"], source: source([member("svc-core", "his/backend/svc-core"), member("svc-portal", "his/frontend/svc-portal"), member("infa", "deploy/infa"), member("login-theme", "login-theme")]) };
    assert.deepEqual(systemFolders(s), [
      { folder: [], projects: ["login-theme", "loose"] },
      { folder: ["deploy"], projects: ["infa"] },
      { folder: ["his", "backend"], projects: ["svc-core"] },
      { folder: ["his", "frontend"], projects: ["svc-portal"] },
    ]);
    assert.equal(memberPath("customer-ai", "customer-ai/his/backend/svc-core"), "his/backend/svc-core");
    assert.equal(memberPath("customer-ai", "elsewhere/svc-core"), "svc-core", "outside the group: its own name");
    assert.equal(parseSystemSource("{not json"), null);
  });
});
