import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AUTONOMY,
  effectivePolicy,
  HiveError,
  modelsFor,
  NETWORK,
  NO_MODEL,
  OPEN_POLICY,
  POLICY_AGENT_KINDS,
  tighten,
  type Actor,
  type AgentPolicy,
  type HiveEvent,
} from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const policy = (p: Partial<AgentPolicy>): AgentPolicy => ({ ...OPEN_POLICY, ...p });

/** Whether `p` allows nothing `base` does not. */
function noLooser(p: AgentPolicy, base: AgentPolicy): string | null {
  if (AUTONOMY.indexOf(p.autonomy) > AUTONOMY.indexOf(base.autonomy)) return `autonomy ${p.autonomy} > ${base.autonomy}`;
  if (NETWORK.indexOf(p.network.mode) > NETWORK.indexOf(base.network.mode)) return `network ${p.network.mode} > ${base.network.mode}`;
  if (p.network.mode === "allowlist" && base.network.mode === "allowlist" && p.network.allow.some((h) => !base.network.allow.includes(h))) {
    return `allow ${p.network.allow} ⊄ ${base.network.allow}`;
  }
  if (base.mcp !== null && (p.mcp === null || p.mcp.some((s) => !base.mcp!.includes(s)))) return `mcp ${p.mcp} ⊄ ${base.mcp}`;
  for (const kind of POLICY_AGENT_KINDS) {
    const allowed = modelsFor(base, kind);
    if (allowed === null) continue;
    const got = modelsFor(p, kind);
    if (got === null || got.some((m) => !allowed.includes(m))) return `models.${kind} ${got} ⊄ ${allowed}`;
  }
  return null;
}

const SAMPLES: AgentPolicy[] = [
  OPEN_POLICY,
  policy({ autonomy: "read" }),
  policy({ autonomy: "propose", mcp: [] }),
  policy({ autonomy: "edit", network: { mode: "off", allow: [] }, mcp: ["codegraph"] }),
  policy({ models: { claude: ["opus", "sonnet"] }, network: { mode: "allowlist", allow: ["github.com", ".npmjs.org"] }, mcp: ["codegraph", "figma"] }),
  policy({ models: { claude: ["haiku"], codex: ["gpt-5.5"] }, network: { mode: "allowlist", allow: ["github.com"] } }),
  policy({ models: { claude: [NO_MODEL] }, autonomy: "full", mcp: ["figma"] }),
];

describe("agent policy (roadmap 27a)", () => {
  it("changes nothing while the hub has set nothing", () => {
    assert.deepEqual(tighten(OPEN_POLICY, null), OPEN_POLICY);
    assert.deepEqual(effectivePolicy(OPEN_POLICY, {}), OPEN_POLICY);
    for (const kind of POLICY_AGENT_KINDS) assert.equal(modelsFor(OPEN_POLICY, kind), null, "any model");
  });

  it("takes the lower autonomy", () => {
    assert.equal(tighten(policy({ autonomy: "edit" }), { autonomy: "read" }).autonomy, "read");
    assert.equal(tighten(policy({ autonomy: "propose" }), { autonomy: "full" }).autonomy, "propose", "a project cannot raise it");
    assert.equal(tighten(policy({ autonomy: "edit" }), {}).autonomy, "edit");
  });

  it("intersects models, takes the other side when one is empty, and says none when nothing is common", () => {
    const hub = policy({ models: { claude: ["opus", "sonnet"], gemini: [] } });
    assert.deepEqual(tighten(hub, { models: { claude: ["sonnet", "haiku"] } }).models, { claude: ["sonnet"] });
    assert.deepEqual(tighten(hub, { models: { codex: ["gpt-5.5"], gemini: ["gemini-3-pro"] } }).models, {
      claude: ["opus", "sonnet"],
      codex: ["gpt-5.5"],
      gemini: ["gemini-3-pro"],
    });
    const none = tighten(hub, { models: { claude: ["haiku"] } });
    assert.deepEqual(none.models.claude, [NO_MODEL]);
    assert.deepEqual(modelsFor(none, "claude"), [], "no model may be used, not any model");
    assert.deepEqual(modelsFor(tighten(none, { models: { claude: ["opus"] } }), "claude"), [], "stays none further down");
  });

  it("takes the lower network, intersects two allowlists and keeps the allowlist's hosts against open", () => {
    const list = (...allow: string[]) => ({ mode: "allowlist" as const, allow });
    assert.deepEqual(tighten(policy({ network: list("github.com", ".npmjs.org") }), { network: list(".npmjs.org", "pypi.org") }).network, list(".npmjs.org"));
    assert.deepEqual(tighten(policy({ network: list("github.com") }), { network: { mode: "open", allow: [] } }).network, list("github.com"));
    assert.deepEqual(tighten(OPEN_POLICY, { network: list("github.com") }).network, list("github.com"));
    assert.deepEqual(tighten(policy({ network: list("github.com") }), { network: { mode: "off", allow: [] } }).network, { mode: "off", allow: [] });
    assert.deepEqual(tighten(policy({ network: { mode: "off", allow: [] } }), { network: list("github.com") }).network, { mode: "off", allow: [] });
  });

  it("intersects MCP servers, null meaning every server", () => {
    assert.deepEqual(tighten(OPEN_POLICY, { mcp: ["codegraph"] }).mcp, ["codegraph"]);
    assert.deepEqual(tighten(policy({ mcp: ["codegraph", "figma"] }), { mcp: null }).mcp, ["codegraph", "figma"]);
    assert.deepEqual(tighten(policy({ mcp: ["codegraph", "figma"] }), { mcp: ["figma", "jira"] }).mcp, ["figma"]);
    assert.deepEqual(tighten(policy({ mcp: [] }), { mcp: ["figma"] }).mcp, []);
  });

  it("is never looser than the default nor than the part, whatever the pair", () => {
    for (const base of SAMPLES) {
      for (const over of SAMPLES) {
        const got = tighten(base, over);
        assert.equal(noLooser(got, base), null, `${JSON.stringify(base)} + ${JSON.stringify(over)} vs base`);
        assert.equal(noLooser(got, over), null, `${JSON.stringify(base)} + ${JSON.stringify(over)} vs part`);
        assert.equal(noLooser(tighten(got, over), got), null, "tightening again never loosens");
      }
      // A part of one field only.
      for (const part of [{ autonomy: "full" as const }, { mcp: null }, { network: { mode: "open" as const, allow: [] } }, { models: {} }]) {
        assert.equal(noLooser(tighten(base, part), base), null, `${JSON.stringify(base)} + ${JSON.stringify(part)}`);
      }
    }
  });

  it("does not change its inputs", () => {
    const base = policy({ models: { claude: ["opus"] }, network: { mode: "allowlist", allow: ["github.com"] }, mcp: ["figma"] });
    const copy = structuredClone(base);
    const got = tighten(base, null);
    got.models.claude!.push("haiku");
    got.network.allow.push("x.org");
    got.mcp!.push("jira");
    assert.deepEqual(base, copy);
  });
});

// ── on the hub ─────────────────────────────────────────────────────────────

const admin: Actor = { name: "duy", role: "admin" };
/** Lead of app, member of web, nothing on billing. */
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "lead", web: "member" } } };
const leadAgent: Actor = { name: "claude.lan-mbp@lan-mbp", role: "agent", access: lead.access };
const member: Actor = { name: "minh", role: "member", access: { projects: { app: "member" } } };
const viewer: Actor = { name: "pm", role: "viewer" };
const runner: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };

async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  assert.fail("expected the call to fail");
}

describe("agent policy on the hub (roadmap 27a)", () => {
  it("lets a hub admin set the default, open where a field is left out", async () => {
    const hive = new SqliteHive(":memory:");
    assert.deepEqual((await hive.call("agentPolicy.get", {}, viewer)).hub, OPEN_POLICY, "nothing set: open");
    const view = await hive.call("agentPolicy.set", { project: null, policy: { autonomy: "edit", network: { mode: "allowlist", allow: ["github.com"] } } }, admin);
    assert.deepEqual(view.hub, { models: {}, autonomy: "edit", network: { mode: "allowlist", allow: ["github.com"] }, mcp: null });
    assert.equal(view.updatedBy, "duy");
    assert.deepEqual((await hive.call("agentPolicy.get", {}, viewer)).hub, view.hub);
    assert.deepEqual((await hive.call("agentPolicy.set", { project: null, policy: null }, admin)).hub, OPEN_POLICY, "null: open again");
  });

  it("lets a lead set their project's part, not another project's nor the hub's default", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("agentPolicy.set", { project: null, policy: { autonomy: "edit" } }, admin);
    await hive.call("agentPolicy.set", { project: "billing", policy: { autonomy: "read" } }, admin);

    const view = await hive.call("agentPolicy.set", { project: "app", policy: { autonomy: "full", models: { claude: ["opus"] } } }, lead);
    assert.deepEqual(view.projects.app, { autonomy: "full", models: { claude: ["opus"] } });
    assert.equal(view.effective.app!.autonomy, "edit", "the part cannot raise the default");
    assert.deepEqual(Object.keys(view.projects), ["app"], "billing is not the lead's to see");

    assert.equal(await refusal(hive.call("agentPolicy.set", { project: "web", policy: { autonomy: "read" } }, lead)), "errors.need.projectSettings");
    assert.equal(await refusal(hive.call("agentPolicy.set", { project: "billing", policy: null }, lead)), "errors.notFound");
    assert.equal(await refusal(hive.call("agentPolicy.set", { project: null, policy: { autonomy: "read" } }, lead)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("agentPolicy.set", { project: "app", policy: null }, leadAgent)), "errors.need.projectSettings", "never an agent token");

    const cleared = await hive.call("agentPolicy.set", { project: "app", policy: null }, lead);
    assert.equal(cleared.projects.app, undefined, "null removes the project's part");
    assert.deepEqual(Object.keys((await hive.call("agentPolicy.get", {}, admin)).projects), ["billing"]);
  });

  it("refuses members", async () => {
    const hive = new SqliteHive(":memory:");
    assert.equal(await refusal(hive.call("agentPolicy.set", { project: "app", policy: { autonomy: "read" } }, member)), "errors.need.projectSettings");
    assert.equal(await refusal(hive.call("agentPolicy.set", { project: null, policy: null }, member)), "errors.hubAdminOnly");
    assert.equal(await refusal(hive.call("agentPolicy.set", { project: "app", policy: null }, viewer)), "errors.roleTooLow");
  });

  it("checks every field", async () => {
    const hive = new SqliteHive(":memory:");
    const bad = (policy: unknown) => refusal(hive.call("agentPolicy.set", { project: "app", policy } as never, admin));
    assert.equal(await bad({ models: { claude: ["opus --dangerously-skip-permissions"] } }), "bad_request");
    assert.equal(await bad({ models: { claude: [NO_MODEL] } }), "bad_request", "nobody types the none marker");
    assert.equal(await bad({ models: { claude: Array.from({ length: 21 }, (_, i) => `m${i}`) } }), "bad_request");
    assert.equal(await bad({ models: { custom: ["x"] } }), "bad_request");
    assert.equal(await bad({ network: { mode: "allowlist", allow: ["https://github.com"] } }), "bad_request");
    assert.equal(await bad({ mcp: ["code graph"] }), "bad_request");
    assert.equal(await bad({ mcp: Array.from({ length: 21 }, (_, i) => `s${i}`) }), "bad_request");
    assert.equal(await bad({ autonomy: "root" }), "bad_request");
    const ok = await hive.call("agentPolicy.set", { project: "app", policy: { models: { claude: ["claude-opus-5-5", "us.anthropic/opus:1"] }, mcp: ["codegraph"] } }, admin);
    assert.deepEqual(ok.projects.app!.models, { claude: ["claude-opus-5-5", "us.anthropic/opus:1"] });
  });

  it("logs the change and tells the webhooks, and the team policy leaves it alone", async () => {
    const events: HiveEvent[] = [];
    const hive = new SqliteHive(":memory:", { onEvent: (e) => events.push(e) });
    await hive.call("agentPolicy.set", { project: "app", policy: { autonomy: "read" } }, lead);
    await hive.call("agentPolicy.set", { project: "app", policy: null }, lead);
    assert.deepEqual(
      events.map((e) => (e.type === "agentPolicy.changed" ? [e.project, e.by, e.policy] : e.type)),
      [
        ["app", "lan", { autonomy: "read" }],
        ["app", "lan", null],
      ],
    );
    const log = await hive.call("admin.audit", { action: "agentPolicy.set" }, admin);
    assert.equal(log.length, 2);
    assert.equal(log.find((e) => e.detailKey === "audit.agentPolicy")?.target, "app");

    await hive.call("agentPolicy.set", { project: null, policy: { autonomy: "propose" } }, admin);
    await hive.call("policy.set", { requiredClis: ["claude"] }, admin);
    assert.equal((await hive.call("agentPolicy.get", {}, admin)).hub.autonomy, "propose");
  });

  it("sends with the heartbeat the default and the parts of the projects the machine has", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("agentPolicy.set", { project: null, policy: { autonomy: "edit" } }, admin);
    for (const p of ["app", "web", "billing"]) await hive.call("agentPolicy.set", { project: p, policy: { autonomy: "read", mcp: [p] } }, admin);
    const beat = (extra: Record<string, unknown> = {}) => hive.call("machines.heartbeat", { machine: "duy-mbp", instance: "aaaaaaaa", ...extra } as never, runner);

    const first = await beat({ projects: ["app", "billing", "other"] });
    assert.equal(first.agentPolicy.hub.autonomy, "edit");
    assert.deepEqual(Object.keys(first.agentPolicy.projects).sort(), ["app", "billing"]);
    assert.deepEqual(first.agentPolicy.projects.app, { autonomy: "read", mcp: ["app"] });
    assert.deepEqual(Object.keys((await beat()).agentPolicy.projects).sort(), ["app", "billing"], "a heartbeat without projects keeps the last list");
    assert.deepEqual(Object.keys((await beat({ projects: ["web"] })).agentPolicy.projects), ["web"]);

    // A machine signed in as a person gets only the projects that person sees, whatever it reports.
    const lanMachine: Actor = { name: "runner.lan-mbp@lan", role: "member", access: lead.access };
    const theirs = await hive.call("machines.heartbeat", { machine: "lan-mbp", instance: "bbbbbbbb", projects: ["app", "billing"] } as never, lanMachine);
    assert.deepEqual(Object.keys(theirs.agentPolicy.projects), ["app"]);
  });
});
