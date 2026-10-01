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
export const POLICY_AGENT_KINDS = ["claude", "codex", "gemini"] as const satisfies readonly AgentKind[];

export interface AgentPolicy {
  /** Model được dùng theo loại agent (claude, codex, gemini). Không có hoặc []: model nào cũng được. */
  models: Partial<Record<AgentKind, string[]>>;
  /** Mức cao nhất một run được làm. */
  autonomy: Autonomy;
  /** allow: host, .domain hoặc host:port như container.allow của gói; chỉ dùng khi mode là allowlist. */
  network: { mode: NetworkMode; allow: string[] };
  /** Tên MCP server được bật thêm ngoài xdev-hive (xdev-hive luôn bật). null: mọi server. */
  mcp: string[] | null;
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
export function tighten(base: AgentPolicy, over: Partial<AgentPolicy> | null): AgentPolicy {
  const own = over?.mcp ?? null;
  const mcp = own === null ? base.mcp : base.mcp === null ? own : common(base.mcp, own);
  return {
    models: tightenModels(base.models, over?.models),
    autonomy: over?.autonomy ? lower(AUTONOMY, base.autonomy, over.autonomy) : base.autonomy,
    network: tightenNetwork(base.network, over?.network),
    mcp: mcp === null ? null : [...mcp],
  };
}

/** What a run of a project may do: the hub's default, tightened by the project's own part. */
export function effectivePolicy(hub: AgentPolicy, project: Partial<AgentPolicy> | null): AgentPolicy {
  return tighten(hub, project);
}

/** One line for the audit log and webhooks, the same in every language (names, not sentences). */
export function policySummary(p: Partial<AgentPolicy>): string {
  const parts: string[] = [];
  if (p.autonomy) parts.push(`autonomy ${p.autonomy}`);
  if (p.network) parts.push(p.network.mode === "allowlist" ? `network allowlist (${p.network.allow.join(", ") || "—"})` : `network ${p.network.mode}`);
  const models = Object.entries(p.models ?? {}).filter(([, list]) => list?.length);
  if (models.length) parts.push(`models ${models.map(([k, list]) => `${k}: ${list!.join(", ")}`).join("; ")}`);
  if (p.mcp !== undefined) parts.push(`mcp ${p.mcp === null ? "*" : p.mcp.join(", ") || "—"}`);
  return parts.join(" · ") || "—";
}

// ── validation (agentPolicy.set) ─────────────────────────────────────────────

const modelList = z.array(z.string().regex(/^[\w.:/-]{1,80}$/, "model: 1–80 chữ, số, . _ : / -")).max(20);
const policyFields = {
  // Only the kinds that have models; an unknown kind is a typo, not a policy.
  models: z.object({ claude: modelList.optional(), codex: modelList.optional(), gemini: modelList.optional() }).strict(),
  autonomy: z.enum(AUTONOMY),
  network: z.object({
    mode: z.enum(NETWORK),
    allow: z.array(z.string().regex(ALLOW_HOST, "host, .domain hoặc host:port")).max(50).default([]),
  }),
  mcp: z.array(z.string().regex(/^[\w-]{1,40}$/, "MCP server: 1–40 chữ, số, _ -")).max(20).nullable(),
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
