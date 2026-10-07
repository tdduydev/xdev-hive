// "Hôm nay": what needs the person, gathered from what the hub and this machine already know. Each source becomes
// items with a stable key, so "seen" and "done" survive reloads (kept in localStorage, per device).
import { HUB_SCOPE, type ImplementationPlan, type MemoryCleanupProposal, type AgentRun, type ChatAction, type HubAlert, type MachineCommand, type Memory, type Permission, type ProjectRole, type Proposal, type RunRecord, type SdlcGateRecord, type SetupItem, type Task } from "@xdev-hive/core";
import { approvalOf } from "#ui/lib/permissions.ts";
import { waitingReason } from "#ui/lib/runs.ts";

export type InboxKind = "releaseFailure" | "plan" | "cleanup" | "agentHold" | "ci" | "waitingRun" | "proposal" | "review" | "memory" | "conflict" | "machine" | "request" | "alert" | "gate" | "leader";
export type InboxTone = "danger" | "warning" | "info";

interface Base {
  key: string;
  tone: InboxTone;
  /** When it happened, for the order and the "8 ph" label; "" when unknown (sorts last). */
  at: string;
  /** Project, doc key or machine: shown in mono. */
  scope: string;
}

export type InboxItem = Base &
  (
    | { kind: "releaseFailure"; task: Task }
    | { kind: "plan"; plan: ImplementationPlan }
    | { kind: "cleanup"; proposal: MemoryCleanupProposal }
    | { kind: "agentHold"; task: Task }
    | { kind: "ci"; run: AgentRun }
    | { kind: "waitingRun"; run: RunRecord; reason: "question" | "ci" | "quota" }
    | { kind: "proposal"; proposal: Proposal }
    | { kind: "review"; task: Task; run: AgentRun | null }
    | { kind: "memory"; memory: Memory }
    | { kind: "conflict"; memory: Memory; other: Memory }
    | { kind: "machine"; item: SetupItem }
    | { kind: "request"; command: MachineCommand }
    | { kind: "alert"; alert: HubAlert }
    | { kind: "gate"; gate: SdlcGateRecord }
    | { kind: "leader"; action: ChatAction }
  );

export interface InboxSources {
  plans?: ImplementationPlan[];
  proposals?: Proposal[];
  cleanup?: MemoryCleanupProposal[];
  reviewTasks?: Task[];
  assignedTasks?: Task[];
  principal?: string;
  /** Memory in scope, any status: pending entries and the ones in a conflict are picked out. */
  memory?: Memory[];
  /** This machine's runs (desktop). */
  runs?: AgentRun[];
  /** The runs machines sent the hub: a task's newest one that waits for a person ("Chờ người", roadmap 49e) is listed. */
  hubRuns?: RunRecord[];
  /** This machine's own setup (desktop): the CLIs and the hive-mcp command. */
  setup?: SetupItem[];
  /** Install requests an admin sent this machine (desktop, hub mode). */
  commands?: MachineCommand[];
  machine?: string;
  /** The hub's open alerts (hub admins, roadmap 22m): one not seen yet by an admin is theirs to look at. */
  alerts?: HubAlert[];
  /** Lifecycle gates reached (roadmap 34): those waiting for a person are listed. */
  gates?: SdlcGateRecord[];
  /** What leaders proposed in Chat and nobody confirmed yet. */
  leader?: ChatAction[];
  /**
   * Whether the person may act on a project's item (null: shared data). Given, an item they could only look at is left
   * out: Hôm nay lists what waits for them (roadmap 35c).
   */
  can?: (owner: string | null, permission: Permission) => boolean;
}

/** Machine tools nobody needs unless their team uses them: not a gap to fix today. */
const OPTIONAL_TOOLS = new Set(["cli:specify"]);

const TONE: Record<InboxKind, InboxTone> = {
  releaseFailure: "danger",
  plan: "warning",
  cleanup: "info",
  agentHold: "warning",
  ci: "danger",
  waitingRun: "warning",
  proposal: "info",
  review: "warning",
  memory: "warning",
  conflict: "danger",
  machine: "info",
  request: "info",
  alert: "danger",
  gate: "warning",
  leader: "info",
};

/** Who decides at a gate, as the hub checks it: a task's review and merge are code review, the rest running agents. */
export function gatePermission(g: Pick<SdlcGateRecord, "gate">): Permission {
  if (g.gate === "release") return "projectSettings";
  if (g.gate === "test") return "qaVerify";
  return g.gate === "review" || g.gate === "merge" ? "codeReview" : "runDispatch";
}

const docProject = (key: string) => /^project\/([^/]+)\//.exec(key)?.[1] ?? null;

/** Every open item, newest first. */
export function buildInbox(src: InboxSources): InboxItem[] {
  const items: InboxItem[] = [];
  const runs = src.runs ?? [];
  const can = src.can ?? (() => true);

  for (const plan of src.plans ?? []) if (plan.status === "waiting" && can(plan.project, "runDispatch")) items.push({ kind: "plan", key: `plan:${plan.id}:${plan.revision}`, tone: TONE.plan, at: plan.readyAt ?? plan.createdAt, scope: plan.project, plan });

  // CI: the newest run of each merge request whose pipeline failed (a fix run, if any, is that newest run).
  const byMr = new Map<string, AgentRun>();
  for (const r of runs) {
    if (!r.mrUrl) continue;
    const cur = byMr.get(r.mrUrl);
    if (!cur || r.createdAt > cur.createdAt) byMr.set(r.mrUrl, r);
  }
  for (const r of byMr.values()) {
    if (r.pipelineStatus !== "failed") continue;
    items.push({ kind: "ci", key: `ci:${r.mrUrl}:${r.pipelineUrl ?? r.mrCheckedAt ?? ""}`, tone: TONE.ci, at: r.mrCheckedAt ?? r.finishedAt ?? r.createdAt, scope: r.project, run: r });
  }

  // Only a task's newest run: an older one that asked something was answered by the run after it.
  const newest = new Map<string, RunRecord>();
  for (const r of src.hubRuns ?? []) {
    const k = `${r.project}/${r.taskId}`;
    const cur = newest.get(k);
    if (!cur || r.createdAt > cur.createdAt) newest.set(k, r);
  }
  for (const r of newest.values()) {
    if (r.plan?.phase === "plan") continue;
    const reason = waitingReason(r);
    if (!reason || !can(r.project, "runDispatch")) continue;
    items.push({ kind: "waitingRun", key: `waitingRun:${r.machineId}/${r.runId}:${reason}:${r.updatedAt}`, tone: TONE.waitingRun, at: r.updatedAt, scope: r.project, run: r, reason });
  }

  for (const p of src.proposals ?? []) {
    if (p.status !== "pending" || !can(docProject(p.docKey), approvalOf(p.docKey))) continue;
    items.push({ kind: "proposal", key: `proposal:${p.id}`, tone: TONE.proposal, at: p.createdAt, scope: p.docKey, proposal: p });
  }

  for (const p of src.cleanup ?? []) {
    if (p.status !== "pending" || !can(p.project, "memoryApprove")) continue;
    items.push({ kind: "cleanup", key: `cleanup:${p.id}`, tone: TONE.cleanup, at: p.createdAt, scope: p.project, proposal: p });
  }

  for (const task of src.reviewTasks ?? []) {
    if (task.status !== "review" || !can(task.project, "codeReview")) continue;
    const run = runs.filter((r) => r.taskId === task.id && r.project === task.project).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    items.push({ kind: "review", key: `review:${task.project}:${task.id}:${task.updatedAt}`, tone: TONE.review, at: task.updatedAt, scope: task.project, task, run });
  }

  for (const task of src.assignedTasks ?? []) {
    if (/^OPS-release-/.test(task.id) && task.status !== "done" && can(task.project, "projectSettings")) items.push({ kind: "releaseFailure", key: `releaseFailure:${task.id}:${task.updatedAt}`, tone: "danger", at: task.updatedAt, scope: task.project, task });

    if (!task.agent?.hold || task.status === "done" || (!can(task.project, "runDispatch") && task.agent.by !== src.principal)) continue;
    items.push({ kind: "agentHold", key: `agentHold:${task.id}:${task.agent.at}:${JSON.stringify(task.agent.hold)}`, tone: TONE.agentHold, at: task.updatedAt, scope: task.project, task });
  }

  const memory = (src.memory ?? []).filter((m) => can(m.project, "memoryApprove"));
  const byId = new Map(memory.map((m) => [m.id, m]));
  const pairs = new Set<string>();
  for (const m of memory) {
    for (const o of m.conflictsWith) {
      const other = byId.get(o);
      const pair = [Math.min(m.id, o), Math.max(m.id, o)].join("-");
      if (!other || pairs.has(pair)) continue;
      pairs.add(pair);
      // The newer entry leads: it is the one that brought the disagreement.
      const [a, b] = m.createdAt >= other.createdAt ? [m, other] : [other, m];
      items.push({ kind: "conflict", key: `conflict:${pair}`, tone: TONE.conflict, at: a.createdAt, scope: a.project ?? "", memory: a, other: b });
    }
  }
  for (const m of memory) {
    if (m.status !== "pending" || m.conflictsWith.length) continue;
    items.push({ kind: "memory", key: `memory:${m.id}`, tone: TONE.memory, at: m.createdAt, scope: m.project ?? "", memory: m });
  }

  // The setup check has no time of its own: these sort last and show no time.
  for (const item of src.setup ?? []) {
    // Spec Kit is a team's choice per repo (roadmap 20a): its row on Cài đặt máy, and the policy when it is required, say so.
    if (item.state === "installed" || OPTIONAL_TOOLS.has(item.id)) continue;
    items.push({ kind: "machine", key: `machine:${item.id}:${item.state}`, tone: TONE.machine, at: "", scope: src.machine ?? "", item });
  }
  for (const c of src.commands ?? []) {
    if (c.status !== "pending") continue;
    items.push({ kind: "request", key: `request:${c.id}`, tone: TONE.request, at: c.requestedAt, scope: src.machine ?? c.machineId, command: c });
  }

  for (const a of src.alerts ?? []) {
    if (a.resolvedAt || a.ackedBy) continue;
    items.push({ kind: "alert", key: `alert:${a.id}`, tone: a.severity === "high" ? "danger" : "warning", at: a.openedAt, scope: a.project ?? "hub", alert: a });
  }

  for (const g of src.gates ?? []) {
    if ((g.status !== "waiting" && g.status !== "escalated") || !can(g.project, gatePermission(g))) continue;
    items.push({ kind: "gate", key: `gate:${g.id}`, tone: g.status === "escalated" ? "danger" : TONE.gate, at: g.createdAt, scope: g.project, gate: g });
  }
  for (const a of src.leader ?? []) {
    if (a.status !== "proposed" || !can(a.project, "chatApprove")) continue;
    items.push({ kind: "leader", key: `leader:${a.id}`, tone: TONE.leader, at: a.createdAt, scope: a.project, action: a });
  }

  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** The project an item belongs to (null: shared data or this machine), for the scope filter. */
export function inboxProject(item: InboxItem): string | null {
  switch (item.kind) {
    case "plan": return item.plan.project;
    case "ci":
    case "waitingRun":
      return item.run.project;
    case "proposal":
      return docProject(item.proposal.docKey);
    case "cleanup": return item.proposal.project;
    case "review":
    case "agentHold":
    case "releaseFailure":
      return item.task.project;
    case "memory":
    case "conflict":
      return item.memory.project;
    case "alert":
      return item.alert.project;
    case "gate":
      return item.gate.project;
    case "leader":
      return item.action.project === HUB_SCOPE ? null : item.action.project;
    default:
      return null;
  }
}

/** Hôm nay's groups (roadmap 49g): by what the person does with the item, whatever its source. */
export const INBOX_GROUPS = ["decide", "review", "qa", "agent", "watch"] as const;
export type InboxGroup = (typeof INBOX_GROUPS)[number];

export function inboxGroup(item: InboxItem): InboxGroup {
  switch (item.kind) {
    case "review":
      return "review";
    case "gate":
      return item.gate.gate === "test" ? "qa" : gatePermission(item.gate) === "codeReview" ? "review" : "decide";
    case "releaseFailure": return "watch";
    case "waitingRun":
    case "agentHold":
    case "ci":
      return "agent";
    case "alert":
    case "machine":
      return "watch";
    default:
      return "decide";
  }
}

/**
 * Which group comes first for the person's highest role in the scope: a lead decides, a reviewer reviews, a member
 * unblocks the agents working for them. What only needs watching comes last for anyone who can act.
 */
const GROUP_ORDER: Record<ProjectRole, readonly InboxGroup[]> = {
  lead: ["decide", "agent", "review", "qa", "watch"],
  reviewer: ["review", "decide", "agent", "qa", "watch"],
  qa: ["qa", "review", "decide", "agent", "watch"],
  member: ["agent", "review", "decide", "qa", "watch"],
  viewer: ["watch", "agent", "review", "qa", "decide"],
};

/** The items in their groups, the groups in the role's order; empty groups left out, each group keeps the items' order. */
export function groupInbox(items: InboxItem[], role: ProjectRole): Array<{ group: InboxGroup; items: InboxItem[] }> {
  return GROUP_ORDER[role].map((group) => ({ group, items: items.filter((i) => inboxGroup(i) === group) })).filter((g) => g.items.length);
}

/** The role a set of permissions amounts to; a custom grant counts as the highest role whose own permission it has. */
export function roleOfPermissions(has: ReadonlySet<Permission>): ProjectRole {
  if (has.has("projectSettings") || has.has("membersManage")) return "lead";
  if (has.has("qaVerify")) return "qa";
  if (has.has("codeReview") || has.has("docApprove") || has.has("memoryApprove") || has.has("chatApprove")) return "reviewer";
  if (has.has("taskWork")) return "member";
  return "viewer";
}

const RANK: Record<ProjectRole, number> = { viewer: 0, member: 1, qa: 2, reviewer: 3, lead: 4 };

/** The highest role among the permission sets the person has on what the scope covers (null: cannot see); viewer when none. */
export function highestRole(perms: Array<ReadonlySet<Permission> | null>): ProjectRole {
  let best: ProjectRole = "viewer";
  for (const p of perms) {
    const r = p ? roleOfPermissions(p) : "viewer";
    if (RANK[r] > RANK[best]) best = r;
  }
  return best;
}

/** What was done with an item, kept after it left its source (approved, merged…) so "Đã xử lý" can list it. */
export interface InboxDone {
  key: string;
  kind: InboxKind;
  tone: InboxTone;
  title: string;
  scope: string;
  note: string;
  at: string;
}

const DONE_KEY = "hive-inbox-done";
const READ_KEY = "hive-inbox-read";
const KEEP = 60;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: remembered for this session only.
  }
}

export const readDone = (): InboxDone[] => load<InboxDone[]>(DONE_KEY, []);
export const writeDone = (list: InboxDone[]): void => save(DONE_KEY, list.slice(0, KEEP));
export const readRead = (): string[] => load<string[]>(READ_KEY, []);
export const writeRead = (keys: string[]): void => save(READ_KEY, keys.slice(-400));

/** "vừa xong", "8 ph", "2 giờ", "3 ngày": the list's short times. */
export function shortAgo(iso: string, now: number, t: (key: "inbox.ago.now" | "inbox.ago.m" | "inbox.ago.h" | "inbox.ago.d", vars?: { n: number }) => string): string {
  if (!iso) return "";
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min) || min < 1) return t("inbox.ago.now");
  if (min < 60) return t("inbox.ago.m", { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("inbox.ago.h", { n: h });
  return t("inbox.ago.d", { n: Math.floor(h / 24) });
}
