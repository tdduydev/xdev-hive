// "Hôm nay": what needs the person, gathered from what the hub and this machine already know. Each source becomes
// items with a stable key, so "seen" and "done" survive reloads (kept in localStorage, per device).
import type { AgentRun, MachineCommand, Memory, Proposal, SetupItem, Task } from "@xdev-hive/core";

export type InboxKind = "ci" | "proposal" | "review" | "memory" | "conflict" | "machine" | "request";
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
    | { kind: "ci"; run: AgentRun }
    | { kind: "proposal"; proposal: Proposal }
    | { kind: "review"; task: Task; run: AgentRun | null }
    | { kind: "memory"; memory: Memory }
    | { kind: "conflict"; memory: Memory; other: Memory }
    | { kind: "machine"; item: SetupItem }
    | { kind: "request"; command: MachineCommand }
  );

export interface InboxSources {
  proposals?: Proposal[];
  reviewTasks?: Task[];
  /** Memory in scope, any status: pending entries and the ones in a conflict are picked out. */
  memory?: Memory[];
  /** This machine's runs (desktop). */
  runs?: AgentRun[];
  /** This machine's own setup (desktop): the CLIs and the hive-mcp command. */
  setup?: SetupItem[];
  /** Install requests an admin sent this machine (desktop, hub mode). */
  commands?: MachineCommand[];
  machine?: string;
}

const TONE: Record<InboxKind, InboxTone> = {
  ci: "danger",
  proposal: "info",
  review: "warning",
  memory: "warning",
  conflict: "danger",
  machine: "info",
  request: "info",
};

const docProject = (key: string) => /^project\/([^/]+)\//.exec(key)?.[1] ?? null;

/** Every open item, newest first. */
export function buildInbox(src: InboxSources): InboxItem[] {
  const items: InboxItem[] = [];
  const runs = src.runs ?? [];

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

  for (const p of src.proposals ?? []) {
    if (p.status !== "pending") continue;
    items.push({ kind: "proposal", key: `proposal:${p.id}`, tone: TONE.proposal, at: p.createdAt, scope: p.docKey, proposal: p });
  }

  for (const task of src.reviewTasks ?? []) {
    if (task.status !== "review") continue;
    const run = runs.filter((r) => r.taskId === task.id && r.project === task.project).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
    items.push({ kind: "review", key: `review:${task.project}:${task.id}:${task.updatedAt}`, tone: TONE.review, at: task.updatedAt, scope: task.project, task, run });
  }

  const memory = src.memory ?? [];
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
    if (item.state === "installed") continue;
    items.push({ kind: "machine", key: `machine:${item.id}:${item.state}`, tone: TONE.machine, at: "", scope: src.machine ?? "", item });
  }
  for (const c of src.commands ?? []) {
    if (c.status !== "pending") continue;
    items.push({ kind: "request", key: `request:${c.id}`, tone: TONE.request, at: c.requestedAt, scope: src.machine ?? c.machineId, command: c });
  }

  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** The project an item belongs to (null: shared data or this machine), for the scope filter. */
export function inboxProject(item: InboxItem): string | null {
  switch (item.kind) {
    case "ci":
      return item.run.project;
    case "proposal":
      return docProject(item.proposal.docKey);
    case "review":
      return item.task.project;
    case "memory":
    case "conflict":
      return item.memory.project;
    default:
      return null;
  }
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
