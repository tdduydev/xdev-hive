// Spending caps (roadmap 27b): a hub admin caps what runs may cost, per project, per person who asked for the runs, or
// for the whole hub, over a day or a month of the hub's clock. Browser-safe: the Costs page draws its bars from the
// same shapes and words the hub sends.
import { z } from "zod";
import { PROJECT_NAME } from "./keys.ts";

export const BUDGET_PERIODS = ["day", "month"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** user: the person who asked for the runs (run request, or the account of the machine's token for a Board run). */
export type BudgetScope = { kind: "project"; project: string } | { kind: "user"; user: string } | { kind: "hub" };

export interface Budget {
  scope: BudgetScope;
  period: BudgetPeriod;
  /** At least one of the two; with both, whichever fills first stops runs. */
  limit: { usd?: number; runs?: number };
}

/** A budget with what its current period used so far (budgets.list). */
export interface BudgetUsage extends Budget {
  /** budgetId: one budget per scope and period, so this names it (alerts, the Costs page). */
  id: string;
  /** When the period began, on the hub's clock. */
  since: string;
  used: { usd: number; runs: number };
  /** The larger share used of its limits: 1 is at the cap, and nothing new starts. */
  ratio: number;
}

/**
 * A full budget as a heartbeat tells machines: no new run starts for that project, that person, or (hub) at all.
 * `self`: the person is the account of this machine's token, so the machine's Board runs count as theirs.
 */
export interface BudgetBlock {
  project?: string;
  user?: string;
  hub?: true;
  self?: boolean;
  key: string;
  vars: Record<string, string | number>;
}

/** Who asked for runs, as run_costs records it: a username, or a token's name when no account owns the token. */
export const BUDGET_USER = /^[\w.@-]{1,100}$/;

export const budgetSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("project"), project: z.string().regex(PROJECT_NAME, "project must be lowercase letters, digits, . _ -") }),
    z.object({ kind: z.literal("user"), user: z.string().regex(BUDGET_USER, "user: letters, digits, . _ @ -") }),
    z.object({ kind: z.literal("hub") }),
  ]),
  period: z.enum(BUDGET_PERIODS),
  limit: z
    .object({ usd: z.number().positive().max(1_000_000).optional(), runs: z.number().int().positive().max(1_000_000).optional() })
    .refine((l) => l.usd !== undefined || l.runs !== undefined, "a budget needs a limit in usd, in runs, or both"),
});

export function budgetId(b: Pick<Budget, "scope" | "period">): string {
  const s = b.scope;
  return s.kind === "project" ? `project:${s.project}:${b.period}` : s.kind === "user" ? `user:${s.user}:${b.period}` : `hub:${b.period}`;
}

/** Midnight today, or the 1st of this month, in the hub's own time zone: "a day" is the hub's working day. */
export function periodStart(period: BudgetPeriod, now: Date): Date {
  return period === "day" ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getFullYear(), now.getMonth(), 1);
}

export function budgetRatio(b: Budget, used: { usd: number; runs: number }): number {
  const usd = b.limit.usd ? used.usd / b.limit.usd : 0;
  const runs = b.limit.runs ? used.runs / b.limit.runs : 0;
  return Math.max(usd, runs);
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The words of errors.budgetExceeded and the budget alerts: whose budget, how much of the limit that is fullest, and
 * since when. Formatted on the hub so a machine and a webhook read the same thing; `from` is a date, not a time.
 */
export function budgetVars(u: BudgetUsage): Record<string, string | number> {
  const s = u.scope;
  const name = s.kind === "project" ? s.project : s.kind === "user" ? s.user : "hub";
  const byUsd = u.limit.usd !== undefined && (u.limit.runs === undefined || u.used.usd / u.limit.usd >= u.used.runs / u.limit.runs);
  const used = byUsd ? `$${u.used.usd.toFixed(2)}` : `${u.used.runs} run`;
  const limit = byUsd ? `$${u.limit.usd!.toFixed(2)}` : `${u.limit.runs} run`;
  return { name, used, limit, from: day(new Date(u.since)), percent: Math.floor(u.ratio * 100) };
}

/** Whether a budget binds a run of this project asked for by this person. */
export function budgetApplies(b: Budget, project: string, user: string | null): boolean {
  const s = b.scope;
  return s.kind === "hub" || (s.kind === "project" && s.project === project) || (s.kind === "user" && user !== null && s.user === user);
}
