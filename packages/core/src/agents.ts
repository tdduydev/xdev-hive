// Agent profiles: one per subscription/account (e.g. two Claude Max accounts = two profiles).
// Browser-safe so the UI can validate forms with the same schema the desktop runner uses.
import { z } from "zod";

export const AGENT_KINDS = ["claude", "codex", "gemini", "antigravity", "custom"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
/** Kinds a run may prefer when it is given (roadmap 24c): the vendors with a subscription to rotate. */
export const PREFER_KINDS = ["claude", "codex", "gemini", "antigravity"] as const;
export type PreferKind = (typeof PREFER_KINDS)[number];

export const AGENT_ROLES = ["plan", "implement", "review"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Best-of-n: at most this many candidates of one implement run. */
export const MAX_CANDIDATES = 4;

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "rate_limited", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Subscription account name shared across machines, e.g. `claude-max-duy`. */
export const ACCOUNT_ID = /^[A-Za-z0-9][\w.@:+-]{0,99}$/;
/** A host a restricted container may reach: host, .domain (with subdomains) or host:port. The agent policy's allow list too. */
export const ALLOW_HOST = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/;

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
  /**
   * Run the CLI inside a Docker container of this image (the machine needs Docker): it sees the task's
   * worktree, the repo's .git and the CLI's login folder, not the rest of the machine. null: run it here.
   */
  container: z
    .object({
      image: z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,199}$/, "image: tên image Docker, vd. xdev-hive-agent"),
      /** restricted: out only through a proxy to the allowed hosts (the default, asked 28/9); open: Docker's usual network. */
      network: z.enum(["restricted", "open"]).default("restricted"),
      /** More hosts a restricted container may reach: host, .domain (with subdomains) or host:port. */
      allow: z.array(z.string().regex(ALLOW_HOST, "host, .domain hoặc host:port")).max(50).default([]),
    })
    .nullable()
    .default(null),
  /** After the quota left (see usageHeadroom), lower runs first; equal priority rotates least-recently-used. */
  priority: z.number().int().min(0).max(100).default(10),
  roles: z.array(z.enum(AGENT_ROLES)).min(1).default(["plan", "implement", "review"]),
  maxConcurrent: z.number().int().min(1).max(8).default(1),
  /** Used when a rate-limit message has no reset time. */
  cooldownMinutes: z.number().int().min(1).max(24 * 60).default(60),
  timeoutMinutes: z.number().int().min(1).max(12 * 60).default(60),
  /**
   * The runner starts no new run on this subscription once its plan usage reaches these shares
   * (Claude Code reports them through /usage, Codex in its session files), keeping the rest for people working by hand.
   */
  stopAtSession: z.number().int().min(1).max(100).default(95),
  stopAtWeek: z.number().int().min(1).max(100).default(90),
});

export type AgentProfile = z.output<typeof agentProfileSchema>;

/** A plan limit as the CLI reports it: share used, and when it resets (the CLI's own words). */
export interface PlanLimit {
  percent: number;
  resets: string | null;
  /**
   * The reset as an instant, read from `resets` by the machine (roadmap 52): the CLI prints it without a year and in
   * its own zone, so the page counts down from this. Absent or null when the text could not be read.
   */
  resetsAt?: string | null;
}

/** How much of a subscription plan's limits is used, from Claude Code's /usage or Codex's session files (roadmap 45). */
export interface PlanUsage {
  /** The rolling session (about five hours). */
  session: PlanLimit | null;
  /** The weekly limit for all models. */
  week: PlanLimit | null;
  /** Other weekly limits the plan has, e.g. per model. */
  others: Array<PlanLimit & { label: string }>;
  /** When the numbers were taken; for Codex the time of its last turn, not of the check. */
  checkedAt: string;
}

/** The limit that stops new runs on the profile, if one is reached. */
export function usageStop(profile: Pick<AgentProfile, "stopAtSession" | "stopAtWeek">, usage: PlanUsage | null | undefined): "session" | "week" | null {
  if (!usage) return null;
  if (usage.session && usage.session.percent >= profile.stopAtSession) return "session";
  if (usage.week && usage.week.percent >= profile.stopAtWeek) return "week";
  return null;
}
/**
 * How much of the plan the profile may still use before a stop threshold, in points: the smaller of the two
 * (session, week). Null when the CLI has reported neither, so it is not known (Gemini, a Codex that never ran here, a
 * profile not checked yet).
 */
export function usageHeadroom(profile: Pick<AgentProfile, "stopAtSession" | "stopAtWeek">, usage: PlanUsage | null | undefined): number | null {
  const left = [
    usage?.session ? profile.stopAtSession - usage.session.percent : null,
    usage?.week ? profile.stopAtWeek - usage.week.percent : null,
  ].filter((n): n is number => n !== null);
  return left.length ? Math.max(0, Math.min(...left)) : null;
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
    container: null,
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
    // --sandbox workspace-write: edits and commands inside the working copy (Codex 0.15x has no --full-auto).
    args: ["exec", "--sandbox", "workspace-write", "{prompt}"],
    env: {},
    enabled: true,
    readOnly: false,
    container: null,
    priority: 20,
    roles: ["implement", "review"],
    maxConcurrent: 1,
    cooldownMinutes: 60,
    timeoutMinutes: 60,
    stopAtSession: 95,
    stopAtWeek: 90,
  },
  antigravity: {
    id: "antigravity-1", label: "Antigravity (Google)", kind: "antigravity", bin: "agy",
    args: ["-p", "{prompt}", "--output-format", "stream-json", "--print-timeout", "{timeoutMinutes}m", "--dangerously-skip-permissions"],
    env: {}, enabled: true, readOnly: false, container: null, priority: 35,
    roles: ["plan", "implement", "review"], maxConcurrent: 1, cooldownMinutes: 60, timeoutMinutes: 60, stopAtSession: 95, stopAtWeek: 90,
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
    container: null,
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
  /** Hub mode: start the runs a project manager queues for this machine on the web (runs.dispatch). Off until the user turns it on. */
  acceptHubRuns: z.boolean().default(false),
});

export type RunnerSettings = z.output<typeof runnerSettingsSchema>;
