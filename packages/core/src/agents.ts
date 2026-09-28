// Agent profiles: one per subscription/account (e.g. two Claude Max accounts = two profiles).
// Browser-safe so the UI can validate forms with the same schema the desktop runner uses.
import { z } from "zod";

export const AGENT_KINDS = ["claude", "codex", "gemini", "custom"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const AGENT_ROLES = ["plan", "implement", "review"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "rate_limited", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Subscription account name shared across machines, e.g. `claude-max-duy`. */
export const ACCOUNT_ID = /^[A-Za-z0-9][\w.@:+-]{0,99}$/;

export const agentProfileSchema = z.object({
  /** Also the agent's name in Hive (HIVE_AGENT), so memory/tasks show which subscription did the work. */
  id: z.string().regex(PROFILE_ID, "id: chữ thường, số, dấu - (tối đa 40)"),
  label: z.string().min(1).max(80),
  kind: z.enum(AGENT_KINDS),
  /**
   * Subscription account behind this profile. Profiles with the same account on any machine share
   * rate-limit cooldowns through the hub. Unset: the cooldown stays on this machine.
   */
  account: z.string().regex(ACCOUNT_ID, "account: chữ, số, . _ @ : + - (tối đa 100)").optional(),
  /** Command name on PATH or absolute path. */
  bin: z.string().min(1).max(500),
  /**
   * Arguments. `{prompt}` is replaced by the task prompt (if absent, the prompt goes to stdin).
   * Also available: `{worktree}`, `{task}`, `{project}`, `{branch}`.
   */
  args: z.array(z.string().max(2000)).max(40),
  /** Extra env, e.g. CLAUDE_CONFIG_DIR=~/.claude-account-2 to use a second login. `~` is expanded. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(2000)).default({}),
  enabled: z.boolean().default(true),
  /**
   * Runs get only Hive's read tools (search memory, read docs and tasks): no memory writes, proposals
   * or task updates. Stops mistaken or prompt-injected writes; the agent can still read this machine's token.
   */
  readOnly: z.boolean().default(false),
  /** Lower runs first. Equal priority rotates least-recently-used. */
  priority: z.number().int().min(0).max(100).default(10),
  roles: z.array(z.enum(AGENT_ROLES)).min(1).default(["plan", "implement", "review"]),
  maxConcurrent: z.number().int().min(1).max(8).default(1),
  /** Used when a rate-limit message has no reset time. */
  cooldownMinutes: z.number().int().min(1).max(24 * 60).default(60),
  timeoutMinutes: z.number().int().min(1).max(12 * 60).default(60),
  /**
   * The runner starts no new run on this subscription once its plan usage reaches these shares
   * (Claude Code reports them through /usage), keeping the rest for people working by hand.
   */
  stopAtSession: z.number().int().min(1).max(100).default(95),
  stopAtWeek: z.number().int().min(1).max(100).default(90),
});

export type AgentProfile = z.output<typeof agentProfileSchema>;

/** A plan limit as the CLI reports it: share used, and when it resets (the CLI's own words). */
export interface PlanLimit {
  percent: number;
  resets: string | null;
}

/** How much of a subscription plan's limits is used, from Claude Code's /usage. */
export interface PlanUsage {
  /** The rolling session (about five hours). */
  session: PlanLimit | null;
  /** The weekly limit for all models. */
  week: PlanLimit | null;
  /** Other weekly limits the plan has, e.g. per model. */
  others: Array<PlanLimit & { label: string }>;
  checkedAt: string;
}

/** The limit that stops new runs on the profile, if one is reached. */
export function usageStop(profile: Pick<AgentProfile, "stopAtSession" | "stopAtWeek">, usage: PlanUsage | null | undefined): "session" | "week" | null {
  if (!usage) return null;
  if (usage.session && usage.session.percent >= profile.stopAtSession) return "session";
  if (usage.week && usage.week.percent >= profile.stopAtWeek) return "week";
  return null;
}
export type AgentProfileInput = z.input<typeof agentProfileSchema>;

/** Starting points. CLI flags differ between versions: check them with `<cli> --help` and edit the profile. */
export const AGENT_TEMPLATES: Record<Exclude<AgentKind, "custom">, AgentProfile> = {
  claude: {
    id: "claude-1",
    label: "Claude Code",
    kind: "claude",
    bin: "claude",
    args: ["-p", "{prompt}", "--permission-mode", "acceptEdits"],
    env: {},
    enabled: true,
    readOnly: false,
    priority: 10,
    roles: ["plan", "implement", "review"],
    maxConcurrent: 1,
    cooldownMinutes: 60,
    timeoutMinutes: 60,
    stopAtSession: 95,
    stopAtWeek: 90,
  },
  codex: {
    id: "codex-1",
    label: "Codex CLI (ChatGPT)",
    kind: "codex",
    bin: "codex",
    args: ["exec", "--full-auto", "{prompt}"],
    env: {},
    enabled: true,
    readOnly: false,
    priority: 20,
    roles: ["implement", "review"],
    maxConcurrent: 1,
    cooldownMinutes: 60,
    timeoutMinutes: 60,
    stopAtSession: 95,
    stopAtWeek: 90,
  },
  gemini: {
    id: "gemini-1",
    label: "Gemini CLI",
    kind: "gemini",
    bin: "gemini",
    args: ["-p", "{prompt}", "--approval-mode", "auto_edit"],
    env: {},
    enabled: true,
    readOnly: false,
    priority: 30,
    roles: ["plan", "implement", "review"],
    maxConcurrent: 1,
    cooldownMinutes: 60,
    timeoutMinutes: 60,
    stopAtSession: 95,
    stopAtWeek: 90,
  },
};

export const DEFAULT_AGENT_PROFILES: AgentProfile[] = Object.values(AGENT_TEMPLATES);

export const runnerSettingsSchema = z.object({
  /** Where task worktrees go. Default: ~/.xdev-hive/worktrees/<project>/<task>. */
  worktreeRoot: z.string().nullable().default(null),
  /** Agents running at the same time across all profiles. */
  maxParallel: z.number().int().min(1).max(8).default(2),
  /** Attempts per run including rotations after rate limits. */
  maxAttempts: z.number().int().min(1).max(6).default(3),
});

export type RunnerSettings = z.output<typeof runnerSettingsSchema>;
