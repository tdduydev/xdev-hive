// Agent policy (roadmap 27a): which models, how much autonomy, which network and MCP servers a run may use.
// The hub keeps a default and a part per project; a project's part, and later a machine's profile, only tighten it.
// Browser-safe: the policy page shows the effective policy with the same rules the runner applies.
import { z } from "zod";
import { ALLOW_HOST, type AgentKind } from "./agents.ts";

export const AUTONOMY = ["read", "propose", "edit", "full"] as const; // tăng dần
export type Autonomy = (typeof AUTONOMY)[number];
export const NETWORK = ["off", "allowlist", "open"] as const; // tăng dần
export type NetworkMode = (typeof NETWORK)[number];
/** The kinds a policy names models for: a custom CLI has no model flag the runner knows. */
export const POLICY_AGENT_KINDS = ["claude", "codex", "gemini", "antigravity", "copilot"] as const satisfies readonly AgentKind[];

export interface AgentPolicy {
  /** Model được dùng theo loại agent (claude, codex, gemini). Không có hoặc []: model nào cũng được. */
  models: Partial<Record<AgentKind, string[]>>;
  /** Mức cao nhất một run được làm. */
  autonomy: Autonomy;
  /** allow: host, .domain hoặc host:port như container.allow của gói; chỉ dùng khi mode là allowlist. */
  network: { mode: NetworkMode; allow: string[] };
  /** Tên MCP server được bật thêm ngoài xdev-hive (xdev-hive luôn bật). null: mọi server. */
  mcp: string[] | null;
  /**
   * Trần output cho run (roadmap 28c): token của mỗi lần gọi MCP, ký tự output của mỗi lệnh Bash (Claude Code đọc
   * MAX_MCP_OUTPUT_TOKENS, BASH_MAX_OUTPUT_LENGTH). null hoặc không có: không đặt. Cấp dưới chỉ hạ được.
   */
  limits?: OutputLimits;
}

export interface OutputLimits {
  mcpOutputTokens: number | null;
  bashOutputChars: number | null;
}

/** Hub chưa đặt gì thì không đổi gì: runs keep doing what they did before 27a. */
export const OPEN_POLICY: AgentPolicy = { models: {}, autonomy: "full", network: { mode: "open", allow: [] }, mcp: null };

/**
 * Stands for "no model at all" when two model lists have nothing in common. An empty list already means "any model",
 * so the intersection cannot be []. Its "!" is outside what agentPolicy.set accepts, so nobody can type it.
 */
export const NO_MODEL = "!none";

/** The models a run of this kind may use: null any, [] none (two lists had nothing in common; the runner refuses). */
export function modelsFor(policy: AgentPolicy, kind: AgentKind): string[] | null {
  const list = policy.models[kind];
  if (!list?.length) return null;
  return list.filter((m) => m !== NO_MODEL);
}

const lower = <T extends string>(order: readonly T[], a: T, b: T): T => (order.indexOf(a) <= order.indexOf(b) ? a : b);
const common = (a: string[], b: string[]) => a.filter((x) => b.includes(x));

function tightenModels(base: AgentPolicy["models"], over: AgentPolicy["models"] | undefined): AgentPolicy["models"] {
  const out: AgentPolicy["models"] = {};
  const kinds = new Set([...Object.keys(base), ...Object.keys(over ?? {})] as AgentKind[]);
  for (const kind of kinds) {
    const [baseList, overList] = [base[kind], over?.[kind]];
    const a = baseList?.length ? baseList : null;
    const b = overList?.length ? overList : null;
    // Both lists: what both allow, or NO_MODEL when that is nothing (an empty list would read as any model).
    const list = !a ? b : !b ? a : common(a, b).length ? common(a, b) : [NO_MODEL];
    if (list) out[kind] = [...list];
  }
  return out;
}

function tightenNetwork(base: AgentPolicy["network"], over: AgentPolicy["network"] | undefined): AgentPolicy["network"] {
  if (!over) return { mode: base.mode, allow: [...base.allow] };
  const mode = lower(NETWORK, base.mode, over.mode);
  if (mode !== "allowlist") return { mode, allow: [] };
  // Both allowlists: only hosts both allow. One open: the allowlist side's hosts.
  if (base.mode === "allowlist" && over.mode === "allowlist") return { mode, allow: common(base.allow, over.allow) };
  return { mode, allow: [...(base.mode === "allowlist" ? base.allow : over.allow)] };
}

/** `base` with `over` on top, never looser than `base`: a lower level only takes away. */
/** The smaller of two limits, either one null meaning none. */
const lowerLimit = (a: number | null | undefined, b: number | null | undefined): number | null => (a == null ? (b ?? null) : b == null ? a : Math.min(a, b));

export function tighten(base: AgentPolicy, over: Partial<AgentPolicy> | null): AgentPolicy {
  const own = over?.mcp ?? null;
  const mcp = own === null ? base.mcp : base.mcp === null ? own : common(base.mcp, own);
  const limits =
    base.limits || over?.limits
      ? {
          mcpOutputTokens: lowerLimit(base.limits?.mcpOutputTokens, over?.limits?.mcpOutputTokens),
          bashOutputChars: lowerLimit(base.limits?.bashOutputChars, over?.limits?.bashOutputChars),
        }
      : null;
  return {
    models: tightenModels(base.models, over?.models),
    autonomy: over?.autonomy ? lower(AUTONOMY, base.autonomy, over.autonomy) : base.autonomy,
    network: tightenNetwork(base.network, over?.network),
    mcp: mcp === null ? null : [...mcp],
    ...(limits ? { limits } : {}),
  };
}

/** What a run of a project may do: the hub's default, tightened by the project's own part. */
export function effectivePolicy(hub: AgentPolicy, project: Partial<AgentPolicy> | null): AgentPolicy {
  return tighten(hub, project);
}

// ── a profile's own autonomy ─────────────────────────────────────────────────
// The policy is only a ceiling: the runner gives a run the lower of it and what the profile's own flags allow, and
// never adds a flag that widens one. Here, not in the runner, so the Agents page reads a profile the same way.

/** The flags that set how much a CLI may do on its own, by kind: those taking a value, and switches. */
export const AUTONOMY_FLAGS: Partial<Record<AgentKind, { valued: string[]; switches: string[] }>> = {
  claude: { valued: ["--permission-mode"], switches: ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"] },
  antigravity: { valued: [], switches: ["--dangerously-skip-permissions"] },
  codex: { valued: ["--sandbox", "-s"], switches: ["--full-auto", "--dangerously-bypass-approvals-and-sandbox"] },
  gemini: { valued: ["--approval-mode"], switches: ["-y", "--yolo"] },
  copilot: { valued: ["--mode"], switches: ["--allow-all-tools", "--allow-all", "--yolo", "--plan", "--autopilot"] },
};

/** The flags the runner puts in for a level (the profile's own come out first). */
export const AUTONOMY_ARGS: Record<Exclude<AgentKind, "custom">, Record<Autonomy, string[]>> = {
  // Lowering flags are unverified: the runner refuses restrictive agy policies instead of fabricating flags.
  antigravity: { read: [], propose: [], edit: [], full: ["--dangerously-skip-permissions"] },
  claude: {
    read: ["--permission-mode", "plan"],
    propose: ["--permission-mode", "plan"],
    edit: ["--permission-mode", "acceptEdits"],
    full: ["--permission-mode", "bypassPermissions"],
  },
  codex: {
    read: ["--sandbox", "read-only"],
    propose: ["--sandbox", "read-only"],
    edit: ["--sandbox", "workspace-write"],
    full: ["--sandbox", "danger-full-access"],
  },
  gemini: {
    read: ["--approval-mode", "plan"],
    propose: ["--approval-mode", "plan"],
    edit: ["--approval-mode", "auto_edit"],
    full: ["--approval-mode", "yolo"],
  },
  copilot: {
    read: ["--mode", "plan", "--deny-tool=write", "--deny-tool=shell"],
    propose: ["--mode", "plan", "--deny-tool=write", "--deny-tool=shell"],
    edit: ["--allow-tool=write", "--allow-tool=read", "--deny-tool=shell"],
    full: ["--allow-all-tools"],
  },
};

/** What each flag value means; a value missing here counts as edit, as the spec says. */
const AUTONOMY_VALUES: Record<string, Autonomy> = {
  plan: "read",
  "read-only": "read",
  acceptEdits: "edit",
  auto_edit: "edit",
  "workspace-write": "edit",
  bypassPermissions: "full",
  "danger-full-access": "full",
  yolo: "full",
};
const FULL_SWITCHES = ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "-y", "--yolo"];

export const lowerAutonomy = (a: Autonomy, b: Autonomy): Autonomy => lower(AUTONOMY, a, b);

/** The value of a flag written `--flag X` or `--flag=X` (the last one wins, as in the CLIs). */
export function flagValue(args: string[], names: string[]): string | null {
  return flagUse(args, names)?.value ?? null;
}

/** flagValue, with the flag as written ("--sandbox read-only", "--permission-mode=plan"). */
function flagUse(args: string[], names: string[]): { value: string; written: string } | null {
  let use: { value: string; written: string } | null = null;
  args.forEach((a, i) => {
    for (const n of names) {
      if (a === n && i + 1 < args.length) use = { value: args[i + 1]!, written: `${a} ${args[i + 1]}` };
      else if (a.startsWith(`${n}=`)) use = { value: a.slice(n.length + 1), written: a };
    }
  });
  return use;
}

/** The autonomy a profile's own args give: `plan` is read, `acceptEdits` edit, a dangerously switch full. */
export function autonomyOf(kind: AgentKind, args: string[]): Autonomy {
  return autonomySource(kind, args).level;
}

/** autonomyOf, with the args it read that from as written ("--permission-mode acceptEdits"); flag null: none. */
export function autonomySource(kind: AgentKind, args: string[]): { level: Autonomy; flag: string | null } {
  const flags = AUTONOMY_FLAGS[kind];
  if (!flags) return { level: "edit", flag: null };
  if (kind === "copilot" && args.includes("--plan")) return { level: "read", flag: "--plan" };
  const full = args.find((a) => FULL_SWITCHES.includes(a) && flags.switches.includes(a));
  if (full) return { level: "full", flag: full };
  const use = flagUse(args, flags.valued);
  return use ? { level: AUTONOMY_VALUES[use.value] ?? "edit", flag: use.written } : { level: "edit", flag: null };
}

/** How much a run of a profile may do on its own, for its card: what its flags give, and that under each ceiling. */
export interface ProfileAutonomy {
  /** What the profile's own args give (autonomyOf); null: a custom CLI, whose flags the runner neither reads nor sets. */
  own: Autonomy | null;
  /** The args `own` comes from, as written; null: none, which the runner counts as edit. */
  flag: string | null;
  /**
   * The hub's ceiling and what a run gets under it; null without a policy (local mode, a hub older than 27a).
   * effective null: a custom CLI, which runs with its own flags at full and is skipped below it.
   */
  hub: { policy: Autonomy; effective: Autonomy | null } | null;
  /** The projects whose own part lowers the hub's ceiling, by name. */
  projects: { project: string; policy: Autonomy; effective: Autonomy | null }[];
}

/** `policy`: the hub's default and the parts of the machine's projects, as the heartbeat brings them; null: none. */
export function profileAutonomy(
  kind: AgentKind,
  args: string[],
  policy: { hub: AgentPolicy; projects: Record<string, Partial<AgentPolicy>> } | null,
): ProfileAutonomy {
  const custom = !AUTONOMY_FLAGS[kind];
  const { level, flag } = autonomySource(kind, args);
  const under = (ceiling: Autonomy) => ({ policy: ceiling, effective: custom ? null : lowerAutonomy(level, ceiling) });
  if (!policy) return { own: custom ? null : level, flag, hub: null, projects: [] };
  const projects = Object.entries(policy.projects)
    .map(([project, part]) => ({ project, ...under(effectivePolicy(policy.hub, part).autonomy) }))
    .filter((p) => p.policy !== policy.hub.autonomy)
    .sort((a, b) => a.project.localeCompare(b.project));
  return { own: custom ? null : level, flag, hub: under(policy.hub.autonomy), projects };
}

/** One line for the audit log and webhooks, the same in every language (names, not sentences). */
export function policySummary(p: Partial<AgentPolicy>): string {
  const parts: string[] = [];
  if (p.autonomy) parts.push(`autonomy ${p.autonomy}`);
  if (p.network) parts.push(p.network.mode === "allowlist" ? `network allowlist (${p.network.allow.join(", ") || "—"})` : `network ${p.network.mode}`);
  const models = Object.entries(p.models ?? {}).filter(([, list]) => list?.length);
  if (models.length) parts.push(`models ${models.map(([k, list]) => `${k}: ${list!.join(", ")}`).join("; ")}`);
  if (p.mcp !== undefined) parts.push(`mcp ${p.mcp === null ? "*" : p.mcp.join(", ") || "—"}`);
  if (p.limits?.mcpOutputTokens != null) parts.push(`mcp output ≤ ${p.limits.mcpOutputTokens} tokens`);
  if (p.limits?.bashOutputChars != null) parts.push(`bash output ≤ ${p.limits.bashOutputChars} chars`);
  return parts.join(" · ") || "—";
}

// ── validation (agentPolicy.set) ─────────────────────────────────────────────

const modelList = z.array(z.string().regex(/^[\w.:/-]{1,80}$/, "model: 1–80 chữ, số, . _ : / -")).max(20);
const policyFields = {
  // Only the kinds that have models; an unknown kind is a typo, not a policy.
  models: z.object({ claude: modelList.optional(), codex: modelList.optional(), gemini: modelList.optional(), antigravity: modelList.optional() }).strict(),
  autonomy: z.enum(AUTONOMY),
  network: z.object({
    mode: z.enum(NETWORK),
    allow: z.array(z.string().regex(ALLOW_HOST, "host, .domain hoặc host:port")).max(50).default([]),
  }),
  mcp: z.array(z.string().regex(/^[\w-]{1,40}$/, "MCP server: 1–40 chữ, số, _ -")).max(20).nullable(),
  limits: z
    .object({
      mcpOutputTokens: z.number().int().min(1000).max(1_000_000).nullable(),
      bashOutputChars: z.number().int().min(1000).max(10_000_000).nullable(),
    })
    .strict(),
};
/** A project's part: only the fields it sets. */
export const agentPolicyPartSchema = z.object(policyFields).partial().strict();
/** The hub's default: a field left out stays open, like OPEN_POLICY. */
export const agentPolicySchema = z
  .object({
    models: policyFields.models.default({}),
    autonomy: policyFields.autonomy.default(OPEN_POLICY.autonomy),
    network: policyFields.network.default({ mode: "open", allow: [] }),
    mcp: policyFields.mcp.default(null),
    limits: policyFields.limits.optional(),
  })
  .strict();

/** What the hub stores under settings key agentPolicy. */
export interface AgentPolicySettings {
  hub: AgentPolicy;
  projects: Record<string, Partial<AgentPolicy>>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const EMPTY_AGENT_POLICY: AgentPolicySettings = { hub: OPEN_POLICY, projects: {}, updatedAt: null, updatedBy: null };

/** agentPolicy.get: what is stored, plus each listed project's policy after the merge. */
export interface AgentPolicyView extends AgentPolicySettings {
  effective: Record<string, AgentPolicy>;
}

export function agentPolicyView(settings: AgentPolicySettings): AgentPolicyView {
  const effective = Object.fromEntries(Object.entries(settings.projects).map(([p, part]) => [p, effectivePolicy(settings.hub, part)] as const));
  return { ...settings, effective };
}
