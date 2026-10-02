import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, parseDocKey, systemOf, systemOwner, withSystemGrants, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";
import { describeProjectContext, planProjectSync } from "#core/sync.ts";

const admin: Actor = { name: "duy", role: "admin" };
// The payment system has two services. Lan leads both, Hoa reviews in api only, Minh is a member of web, Tú is elsewhere.
const lan: Actor = { name: "lan", role: "member", account: "lan", access: { projects: { "pay-api": "lead", "pay-web": "lead" } } };
const hoa: Actor = { name: "hoa", role: "member", account: "hoa", access: { projects: { "pay-api": "reviewer" } } };
const minh: Actor = { name: "minh", role: "member", account: "minh", access: { projects: { "pay-web": "member" } } };
const tu: Actor = { name: "tu", role: "member", account: "tu", access: { projects: { crm: "lead" } } };

async function setup() {
  const hive = new SqliteHive(":memory:", { memoryRequiresApproval: true });
  await hive.call("systems.save", { name: "payment", projects: ["pay-api", "pay-web"] }, admin);
  await hive.call("systems.save", { name: "crm-sys", projects: ["crm"] }, admin);
  await hive.call("docs.save", { key: "org/style", title: "Style", content: "# Style\n\nTabs.\n", includeInAgents: true }, admin);
  await hive.call("docs.save", { key: "system/payment/api-contract", title: "API contract", content: "# API contract\n\nPOST /charge returns 201.\n", includeInAgents: true }, admin);
  await hive.call("docs.save", { key: "system/payment/events", title: "Events", content: "# Events\n\ncharge.created\n" }, admin);
  await hive.call("docs.save", { key: "system/crm-sys/contacts", title: "Contacts", content: "# Contacts\n" }, admin);
  return hive;
}
const code = (c: string) => (e: unknown) => e instanceof HiveError && e.code === c;

describe("a system's docs and memory (roadmap 19c)", () => {
  it("keys a system's doc as system/<name>/<slug>, owned by sys:<name>", () => {
    assert.deepEqual(parseDocKey("system/payment/api-contract"), { scope: "system", project: "sys:payment", slug: "api-contract", skill: false });
    assert.throws(() => parseDocKey("system/payment/skills/deploy"), code("bad_request"));
    assert.equal(systemOwner("payment"), "sys:payment");
    assert.equal(systemOf("sys:payment"), "payment");
    assert.equal(systemOf("pay-api"), null);
  });

  it("derives what an account may do in a system from its services", () => {
    const systems = [{ name: "payment", projects: ["pay-api", "pay-web"] }];
    const grant = (a: Actor) => withSystemGrants(a.access, systems)?.projects["sys:payment"];
    // A lead of every service: everything a lead does.
    assert.ok((grant(lan) as { permissions: string[] }).permissions.includes("docApprove"));
    // A reviewer of one service reads, proposes and writes memory, but approves nothing that binds the other.
    assert.deepEqual((grant(hoa) as { permissions: string[] }).permissions.sort(), ["docPropose", "memoryWrite", "view"]);
    assert.equal(grant(tu), undefined, "no service of the system: nothing");
    assert.equal(withSystemGrants(undefined, systems), undefined, "unrestricted stays unrestricted");
  });

  it("gives a service's list and agents the docs of its systems, not of others", async () => {
    const hive = await setup();
    const keys = (await hive.call("docs.list", { project: "pay-api" }, admin)).map((d) => d.key);
    assert.deepEqual(keys.filter((k) => !k.startsWith("project/")), ["org/style", "system/payment/api-contract", "system/payment/events"]);
    assert.equal((await hive.call("docs.list", { project: "crm" }, admin)).some((d) => d.key.startsWith("system/payment/")), false);
    // Minh (web) reads the contract; Tú (crm only) does not see it at all.
    assert.equal((await hive.call("docs.get", { key: "system/payment/api-contract" }, minh))?.title, "API contract");
    await assert.rejects(hive.call("docs.get", { key: "system/payment/api-contract" }, tu), code("not_found"));
    assert.equal((await hive.call("docs.list", {}, tu)).some((d) => d.scope === "system" && d.project === "sys:payment"), false);
  });

  it("lets a member of one service propose a change, and only someone with rights in every service approve it", async () => {
    const hive = await setup();
    await assert.rejects(hive.call("docs.save", { key: "system/payment/api-contract", title: "API contract", content: "# x\n", baseVersion: 1 }, minh), code("forbidden"));
    const p = await hive.call("proposals.create", { docKey: "system/payment/api-contract", baseVersion: 1, content: "# API contract\n\nPOST /charge returns 201 or 409.\n", reason: "409 on retry" }, minh);
    await assert.rejects(hive.call("proposals.approve", { id: p.id }, hoa), code("forbidden"));
    assert.equal((await hive.call("proposals.approve", { id: p.id }, lan)).status, "approved");
    // A doc of a system that is not there is refused.
    await assert.rejects(hive.call("docs.save", { key: "system/ghost/x", title: "X", content: "# X\n" }, admin), code("not_found"));
  });

  it("finds a system's memory from each of its services, keeps it pending for those who cannot approve it", async () => {
    const hive = await setup();
    const m = await hive.call("memory.write", { system: "payment", kind: "decision", content: "Charges are idempotent by order id." }, hoa);
    assert.deepEqual([m.project, m.status], ["sys:payment", "pending"]);
    await assert.rejects(hive.call("memory.write", { system: "payment", kind: "decision", content: "x" }, tu), code("not_found"));
    await assert.rejects(hive.call("memory.write", { system: "payment", project: "pay-api", kind: "decision", content: "x" } as never, lan), code("bad_request"));
    await hive.call("memory.approve", { id: m.id }, lan);
    const found = await hive.call("memory.search", { project: "pay-web", query: "idempotent" }, minh);
    assert.deepEqual(found.map((x) => x.id), [m.id]);
    assert.deepEqual(await hive.call("memory.search", { project: "crm", query: "idempotent" }, admin), []);
    assert.deepEqual((await hive.call("memory.list", { system: "payment" }, minh)).map((x) => x.id), [m.id]);
    // The system scope on the web lists the services' memory and the system's own.
    assert.deepEqual((await hive.call("memory.list", { projects: ["pay-api", "pay-web"] }, admin)).map((x) => x.id), [m.id]);
  });

  it("puts a system's AGENTS.md docs into each service's AGENTS.md, after the team's", async () => {
    const hive = await setup();
    await hive.call("docs.save", { key: "system/payment/db-rules", title: "DB rules", content: "# DB\n\nNo raw SQL.\n", includeInAgents: true, paths: ["src/db/**"] }, admin);
    const summaries = await hive.call("docs.list", { project: "pay-api" }, admin);
    const docs = (await Promise.all(summaries.map((s) => hive.call("docs.get", { key: s.key }, admin)))).filter((d) => d !== null);
    const files = planProjectSync("pay-api", docs);
    const agents = files[0]!.content;
    assert.ok(agents.indexOf("<!-- org/style v1 -->") < agents.indexOf("<!-- system/payment/api-contract v1 -->"));
    assert.equal(agents.includes("charge.created"), false, "not put in AGENTS.md: the events doc stays a doc");
    assert.ok(files.some((f) => f.path === "src/db/AGENTS.md" && f.content.includes("No raw SQL.")));
    const context = describeProjectContext("pay-api", docs);
    assert.deepEqual(context.blocks.find((b) => b.kind === "system")?.items.map((i) => i.key), ["system/payment/api-contract"]);
    assert.deepEqual((await hive.call("docs.context", { project: "pay-api" }, admin)).blocks.find((b) => b.kind === "system")?.items.map((i) => i.key), ["system/payment/api-contract"]);
  });

  it("keeps a system that still has docs or memory", async () => {
    const hive = await setup();
    await assert.rejects(hive.call("systems.remove", { name: "payment" }, admin), (e: unknown) => e instanceof HiveError && e.key === "errors.systemHasData");
    await hive.call("systems.save", { name: "empty", projects: ["x"] }, admin);
    assert.deepEqual(await hive.call("systems.remove", { name: "empty" }, admin), { removed: true });
  });
});
