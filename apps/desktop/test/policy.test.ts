import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_TEMPLATES, autonomyOf, autonomySource, NO_MODEL, OPEN_POLICY, profileAutonomy, type AgentPolicy, type AgentProfile, type ModelSelection } from "@xdev-hive/core";
import { applyAutonomy, applyPolicy, buildCommand, codexMcpNames, effortOf, modelOf, policyBlocks, policyLine, ranOn, routeProfile } from "#desktop/main/runner/command.ts";

const pol = (over: Partial<AgentPolicy>): AgentPolicy => ({ ...OPEN_POLICY, ...over });
const boxed = (p: AgentProfile, container: Partial<NonNullable<AgentProfile["container"]>> = {}): AgentProfile => ({
  ...p,
  container: { image: "xdev-hive-agent", network: "restricted", allow: [], ...container },
});
const vars = { prompt: "do it", worktree: "/tmp/wt", task: "T-1", project: "demo", branch: "ai/T-1", run: "R-1" };

describe("applyAutonomy", () => {
  const claude = AGENT_TEMPLATES.claude.args; // -p {prompt} --permission-mode acceptEdits
  const codex = AGENT_TEMPLATES.codex.args; // exec --sandbox workspace-write {prompt}
  const gemini = AGENT_TEMPLATES.gemini.args; // Native JSONL, edits approved

  it("reads a profile's own level from its flags", () => {
    assert.equal(autonomyOf("claude", ["-p", "x", "--permission-mode", "plan"]), "read");
    assert.equal(autonomyOf("claude", ["-p", "x", "--permission-mode=bypassPermissions"]), "full");
    assert.equal(autonomyOf("claude", ["-p", "x", "--dangerously-skip-permissions"]), "full");
    assert.equal(autonomyOf("claude", ["-p", "x"]), "edit", "no flag counts as edit");
    assert.equal(autonomyOf("codex", ["exec", "-s", "read-only"]), "read");
    assert.equal(autonomyOf("codex", ["exec", "--full-auto"]), "edit");
    assert.equal(autonomyOf("codex", ["exec", "--dangerously-bypass-approvals-and-sandbox"]), "full");
    assert.equal(autonomyOf("gemini", ["-p", "x", "--yolo"]), "full");
    assert.equal(autonomyOf("gemini", ["-p", "x", "--approval-mode", "something-new"]), "edit", "an unknown value counts as edit");
  });

  it("names the flag a level comes from, as written", () => {
    assert.deepEqual(autonomySource("claude", claude), { level: "edit", flag: "--permission-mode acceptEdits" });
    assert.deepEqual(autonomySource("claude", ["-p", "x", "--permission-mode", "plan", "--permission-mode=bypassPermissions"]), {
      level: "full",
      flag: "--permission-mode=bypassPermissions",
    });
    assert.deepEqual(autonomySource("claude", ["-p", "x", "--dangerously-skip-permissions"]), { level: "full", flag: "--dangerously-skip-permissions" });
    assert.deepEqual(autonomySource("claude", ["-p", "x", "--permission-mode"]), { level: "edit", flag: null }, "a flag without its value is none");
    assert.deepEqual(autonomySource("codex", codex), { level: "edit", flag: "--sandbox workspace-write" });
    assert.deepEqual(autonomySource("custom", ["--yolo"]), { level: "edit", flag: null }, "the runner does not read a custom CLI");
  });

  it("profileAutonomy: the profile's own level under the hub's ceiling and each project's lower one", () => {
    assert.deepEqual(profileAutonomy("claude", claude, null), { own: "edit", flag: "--permission-mode acceptEdits", hub: null, projects: [] });
    // The report of 2/10: the hub says full, the profile still runs at acceptEdits.
    const policy = { hub: pol({ autonomy: "full" }), projects: { b: { autonomy: "read" as const }, a: { autonomy: "full" as const }, c: {} } };
    assert.deepEqual(profileAutonomy("claude", claude, policy), {
      own: "edit",
      flag: "--permission-mode acceptEdits",
      hub: { policy: "full", effective: "edit" },
      projects: [{ project: "b", policy: "read", effective: "read" }],
    });
    const yolo = profileAutonomy("codex", ["exec", "--dangerously-bypass-approvals-and-sandbox"], { hub: pol({ autonomy: "edit" }), projects: {} });
    assert.deepEqual(yolo.hub, { policy: "edit", effective: "edit" }, "the policy lowers a profile above it");
    const custom = profileAutonomy("custom", ["{prompt}"], { hub: pol({ autonomy: "propose" }), projects: {} });
    assert.deepEqual(custom, { own: null, flag: null, hub: { policy: "propose", effective: null }, projects: [] });
  });

  it("claude: each level", () => {
    assert.deepEqual(applyAutonomy("claude", claude, "read"), ["-p", "{prompt}", "--permission-mode", "plan"]);
    assert.deepEqual(applyAutonomy("claude", claude, "propose"), ["-p", "{prompt}", "--permission-mode", "plan"]);
    assert.deepEqual(applyAutonomy("claude", claude, "edit"), claude);
    assert.deepEqual(applyAutonomy("claude", claude, "full"), claude, "a profile at edit stays at edit under full");
    const full = ["-p", "{prompt}", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"];
    assert.deepEqual(applyAutonomy("claude", full, "full"), full);
    assert.deepEqual(applyAutonomy("claude", full, "edit"), ["-p", "{prompt}", "--permission-mode", "acceptEdits"], "the dangerously flags go");
    assert.deepEqual(applyAutonomy("claude", ["-p", "{prompt}", "--permission-mode=bypassPermissions"], "read"), ["-p", "{prompt}", "--permission-mode", "plan"]);
  });

  it("codex: each level, after exec", () => {
    assert.deepEqual(applyAutonomy("codex", codex, "read"), ["exec", "--sandbox", "read-only", "{prompt}"]);
    assert.deepEqual(applyAutonomy("codex", codex, "propose"), ["exec", "--sandbox", "read-only", "{prompt}"]);
    assert.deepEqual(applyAutonomy("codex", codex, "edit"), codex);
    assert.deepEqual(applyAutonomy("codex", codex, "full"), codex);
    const yolo = ["exec", "--dangerously-bypass-approvals-and-sandbox", "{prompt}"];
    assert.deepEqual(applyAutonomy("codex", yolo, "full"), yolo);
    assert.deepEqual(applyAutonomy("codex", yolo, "edit"), ["exec", "--sandbox", "workspace-write", "{prompt}"]);
    assert.deepEqual(applyAutonomy("codex", ["exec", "--full-auto", "-s", "danger-full-access", "{prompt}"], "read"), ["exec", "--sandbox", "read-only", "{prompt}"]);
  });

  it("gemini: each level", () => {
    assert.deepEqual(applyAutonomy("gemini", gemini, "read"), ["--output-format", "stream-json", "--approval-mode", "plan"]);
    assert.deepEqual(applyAutonomy("gemini", gemini, "propose"), ["--output-format", "stream-json", "--approval-mode", "plan"]);
    assert.deepEqual(applyAutonomy("gemini", gemini, "edit"), gemini);
    assert.deepEqual(applyAutonomy("gemini", gemini, "full"), gemini);
    assert.deepEqual(applyAutonomy("gemini", ["-p", "{prompt}", "-y"], "full"), ["-p", "{prompt}", "-y"]);
    assert.deepEqual(applyAutonomy("gemini", ["-p", "{prompt}", "--yolo"], "edit"), ["-p", "{prompt}", "--approval-mode", "auto_edit"]);
  });

  it("keeps a profile's lower level", () => {
    const plan = ["-p", "{prompt}", "--permission-mode", "plan"];
    for (const level of ["propose", "edit", "full"] as const) assert.deepEqual(applyAutonomy("claude", plan, level), plan);
    const ro = ["exec", "--sandbox", "read-only", "{prompt}"];
    assert.deepEqual(applyAutonomy("codex", ro, "full"), ro);
  });

  it("leaves a custom CLI alone", () => {
    assert.deepEqual(applyAutonomy("custom", ["--whatever"], "read"), ["--whatever"]);
  });
});

describe("policyBlocks", () => {
  it("lets every profile run under the open policy", () => {
    for (const p of Object.values(AGENT_TEMPLATES)) assert.equal(policyBlocks(p, OPEN_POLICY), null);
    assert.equal(policyBlocks({ ...AGENT_TEMPLATES.claude, kind: "custom" }, OPEN_POLICY), null);
  });

  it("models: blocks a model outside the list, and every model when two lists had none in common", () => {
    const sonnet = pol({ models: { claude: ["sonnet"] } });
    const opus = { ...AGENT_TEMPLATES.claude, args: [...AGENT_TEMPLATES.claude.args, "--model", "opus"] };
    assert.match(policyBlocks(opus, sonnet) ?? "", /opus/);
    assert.match(policyBlocks({ ...opus, args: ["-p", "{prompt}", "--model=opus"] }, sonnet) ?? "", /opus/);
    assert.equal(policyBlocks({ ...opus, args: ["-p", "{prompt}", "--model", "sonnet"] }, sonnet), null);
    assert.equal(policyBlocks(AGENT_TEMPLATES.claude, sonnet), null, "no model of its own: it gets the first one");
    assert.equal(policyBlocks(AGENT_TEMPLATES.codex, sonnet), null, "another kind's list");
    assert.ok(policyBlocks(AGENT_TEMPLATES.claude, pol({ models: { claude: [NO_MODEL] } })));
    assert.equal(modelOf(["exec", "-m", "gpt-5", "{prompt}"]), "gpt-5");
  });

  it("network: blocks a profile outside a container unless the network is open", () => {
    for (const mode of ["off", "allowlist"] as const) {
      const p = pol({ network: { mode, allow: [] } });
      assert.ok(policyBlocks(AGENT_TEMPLATES.claude, p), mode);
      assert.equal(policyBlocks(boxed(AGENT_TEMPLATES.claude), p), null, `${mode}: a container`);
      assert.equal(policyBlocks(boxed(AGENT_TEMPLATES.claude, { network: "open" }), p), null, `${mode}: an open container is narrowed, not blocked`);
    }
  });

  it("blocks a custom CLI when autonomy or MCP is limited", () => {
    const custom: AgentProfile = { ...AGENT_TEMPLATES.claude, kind: "custom" };
    assert.ok(policyBlocks(custom, pol({ autonomy: "edit" })));
    assert.ok(policyBlocks(custom, pol({ mcp: [] })));
  });
});

describe("applyPolicy", () => {
  it("changes nothing under the open policy", () => {
    for (const p of Object.values(AGENT_TEMPLATES)) assert.deepEqual(applyPolicy(p, OPEN_POLICY).profile, p);
    const box = boxed(AGENT_TEMPLATES.claude, { network: "open", allow: ["example.com"] });
    assert.deepEqual(applyPolicy(box, OPEN_POLICY).profile, box);
  });

  it("adds the first model when the profile sets none", () => {
    const p = pol({ models: { claude: ["sonnet", "opus"], codex: ["gpt-5"] } });
    const claude = applyPolicy(AGENT_TEMPLATES.claude, p);
    assert.deepEqual(claude.profile.args.slice(-2), ["--model", "sonnet"]);
    assert.equal(claude.model, "sonnet");
    assert.deepEqual(applyPolicy(AGENT_TEMPLATES.codex, p).profile.args.slice(0, 3), ["exec", "--model", "gpt-5"]);
  });

  it("read: plan mode and Hive read-only; propose: plan mode, Hive writable", () => {
    const read = applyPolicy(AGENT_TEMPLATES.claude, pol({ autonomy: "read" }));
    assert.equal(read.profile.readOnly, true);
    assert.equal(read.autonomy, "read");
    assert.ok(read.profile.args.join(" ").includes("--permission-mode plan"));
    const propose = applyPolicy(AGENT_TEMPLATES.claude, pol({ autonomy: "propose" }));
    assert.equal(propose.profile.readOnly, false);
    assert.equal(propose.autonomy, "propose");
    assert.equal(applyPolicy({ ...AGENT_TEMPLATES.claude, readOnly: true }, OPEN_POLICY).profile.readOnly, true, "a read-only profile stays so");
  });

  it("narrows the container's network", () => {
    const box = boxed(AGENT_TEMPLATES.claude, { network: "open", allow: ["example.com", ".corp.local"] });
    assert.deepEqual(applyPolicy(box, pol({ network: { mode: "off", allow: [] } })).profile.container, { image: "xdev-hive-agent", network: "restricted", allow: [] });
    assert.deepEqual(applyPolicy(box, pol({ network: { mode: "allowlist", allow: [".corp.local", "other.org"] } })).profile.container, {
      image: "xdev-hive-agent",
      network: "restricted",
      allow: [".corp.local"],
    });
  });

  it("MCP: Claude's --mcp-config keeps xdev-hive and the allowed servers", () => {
    const features = { codegraph: true, superpowers: false };
    const mcpOf = (mcp: string[] | null) => {
      const { args } = buildCommand(AGENT_TEMPLATES.claude, vars, features, undefined, mcp);
      return {
        servers: Object.keys(JSON.parse(args[args.indexOf("--mcp-config") + 1]!).mcpServers),
        allow: JSON.parse(args[args.indexOf("--settings") + 1]!).permissions.allow,
      };
    };
    assert.deepEqual(mcpOf(null), { servers: ["xdev-hive", "codegraph"], allow: ["mcp__xdev-hive", "mcp__codegraph"] });
    assert.deepEqual(mcpOf([]), { servers: ["xdev-hive"], allow: ["mcp__xdev-hive"] });
    assert.deepEqual(mcpOf(["codegraph"]).servers, ["xdev-hive", "codegraph"]);
  });

  it("MCP: Gemini gets --allowed-mcp-server-names, Codex turns the others off", () => {
    const p = pol({ mcp: ["codegraph"] });
    const gemini = applyPolicy(AGENT_TEMPLATES.gemini, p).profile.args;
    assert.deepEqual(gemini.slice(-4), ["--allowed-mcp-server-names", "xdev-hive", "--allowed-mcp-server-names", "codegraph"]);
    const codex = applyPolicy(AGENT_TEMPLATES.codex, p, ["xdev-hive", "codegraph", "github", "my.server"]).profile.args;
    assert.deepEqual(codex, ["exec", "-c", "mcp_servers.github.enabled=false", "-c", 'mcp_servers."my.server".enabled=false', "--sandbox", "workspace-write", "{prompt}"]);
    assert.deepEqual(applyPolicy(AGENT_TEMPLATES.codex, OPEN_POLICY, ["github"]).profile.args, AGENT_TEMPLATES.codex.args, "null: every server");
  });

  it("reads Codex's server names from config.toml", () => {
    const toml = '[mcp_servers.xdev-hive]\ncommand = "hive-mcp"\n[mcp_servers.xdev-hive.env]\nHIVE_AGENT = "codex"\n[mcp_servers."my.server"]\nurl = "x"\n[profiles.fast]\n';
    assert.deepEqual(codexMcpNames(toml), ["xdev-hive", "my.server"]);
  });

  it("writes one policy line for the run log", () => {
    const p = pol({ autonomy: "read", mcp: [], models: { claude: ["sonnet"] } });
    const line = policyLine(p, applyPolicy(AGENT_TEMPLATES.claude, p));
    assert.match(line, /^# policy /);
    assert.match(line, /model sonnet · autonomy read · Hive read-only · network host · mcp xdev-hive$/);
  });
});

describe("what a run ran on (roadmap 54a)", () => {
  it("reads the effort each CLI takes, the last one winning", () => {
    assert.equal(effortOf("claude", ["-p", "{prompt}", "--effort", "low", "--effort=high"]), "high");
    assert.equal(effortOf("antigravity", ["--effort", "medium"]), "medium");
    assert.equal(effortOf("codex", ["exec", "-c", "model_reasoning_effort=low", "--config", 'model_reasoning_effort="xhigh"']), "xhigh");
    assert.equal(effortOf("codex", ["exec", "--config=model_reasoning_effort='medium'"]), "medium");
    assert.equal(effortOf("codex", ["exec", "-c", "model_verbosity=low", "--effort", "high"]), null, "codex has no --effort");
    assert.equal(effortOf("claude", ["-p", "{prompt}"]), null, "the CLI's default");
    assert.equal(effortOf("gemini", ["--effort", "high"]), null);
  });

  it("reads the model and effort from the args after the policy, none from a custom CLI", () => {
    const fit = applyPolicy({ ...AGENT_TEMPLATES.codex, args: ["exec", "-c", "model_reasoning_effort=high", "{prompt}"] }, { ...OPEN_POLICY, models: { codex: ["gpt-6.1-sol"] } });
    assert.deepEqual(ranOn(fit.profile), { model: "gpt-6.1-sol", effort: "high" });
    assert.deepEqual(ranOn(AGENT_TEMPLATES.claude), { model: null, effort: null });
    assert.deepEqual(ranOn({ ...AGENT_TEMPLATES.claude, kind: "custom", args: ["--model", "x", "--effort", "low"] }), { model: null, effort: null });
  });
});

describe("the hub's model choice on the command (roadmap 54c)", () => {
  const light: ModelSelection = {
    tier: "light",
    models: { claude: { model: "sonnet", effort: "low" }, codex: { model: "gpt-6-luna", effort: "medium" }, antigravity: { model: "gemini-3.8-flash", effort: "low" } },
    reason: "docs/s, balanced",
  };
  const route = (p: AgentProfile, policy: AgentPolicy = OPEN_POLICY, selection: ModelSelection | null = light) => routeProfile(p, applyPolicy(p, policy).profile, policy, selection);

  it("adds each CLI's own flags, and Sonnet subagents on a cheap tier", () => {
    const claude = route(AGENT_TEMPLATES.claude);
    assert.deepEqual(ranOn(claude.profile), { model: "sonnet", effort: "low" });
    assert.equal(claude.profile.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
    assert.equal(claude.note, "sonnet · effort low · tier light (docs/s, balanced)");
    const codex = route(AGENT_TEMPLATES.codex).profile.args;
    assert.deepEqual(codex.slice(0, 5), ["exec", "-m", "gpt-6-luna", "-c", "model_reasoning_effort=medium"], "after exec");
    assert.deepEqual(ranOn(route(AGENT_TEMPLATES.antigravity).profile), { model: "gemini-3.8-flash", effort: "low" });
    const strong = route(AGENT_TEMPLATES.claude, OPEN_POLICY, { ...light, tier: "strong", models: { claude: { model: "opus", effort: "medium" } } });
    assert.equal(strong.profile.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  });

  it("leaves a model or effort the profile set, and changes nothing without a choice", () => {
    const pinned = route({ ...AGENT_TEMPLATES.claude, args: [...AGENT_TEMPLATES.claude.args, "--model", "opus"] });
    assert.deepEqual(ranOn(pinned.profile), { model: "opus", effort: null });
    assert.match(pinned.note!, /^opus · pinned by the profile's args/);
    const effort = route({ ...AGENT_TEMPLATES.claude, args: [...AGENT_TEMPLATES.claude.args, "--effort", "high"] });
    assert.deepEqual(ranOn(effort.profile), { model: "sonnet", effort: "high" });
    const env = route({ ...AGENT_TEMPLATES.claude, env: { CLAUDE_CODE_EFFORT_LEVEL: "high" } });
    assert.equal(effortOf("claude", env.profile.args), null, "the env beats the flag in Claude Code");
    const off = route(AGENT_TEMPLATES.claude, OPEN_POLICY, null);
    assert.deepEqual([off.profile.args, off.note], [AGENT_TEMPLATES.claude.args, null]);
  });

  it("gives way to the agent policy (27a)", () => {
    const opusOnly = pol({ models: { claude: ["opus", "haiku"] } });
    const fit = route(AGENT_TEMPLATES.claude, opusOnly);
    assert.equal(modelOf(fit.profile.args), "opus");
    assert.equal(fit.profile.args.filter((a) => a === "--model").length, 1, "the policy's model replaced, not doubled");
    assert.match(fit.note!, /sonnet not allowed by the policy$/);
  });
});
