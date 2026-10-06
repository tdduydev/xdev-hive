// Tính năng on the web (roadmap 49d, docs/specs/49-ux-roles.md "Trang Tính năng"): which column of the board a
// feature is in, whether it waits for the person reading, and the checklist its Kiểm thử tab reads out of spec.md.
// Free of React so a test can read it; pages/Features.tsx draws what it returns.
import { specTaskPrefix, type Permission, type SdlcFlow, type SdlcFlowTask, type SdlcGateRecord, type SpecFeature, type Task } from "@xdev-hive/core";

/** The board's columns, in the order of the work. */
export const FEATURE_COLUMNS = ["spec", "plan", "tasks", "doing", "review", "done"] as const;
export type FeatureColumn = (typeof FEATURE_COLUMNS)[number];

/** The tabs of one feature. */
export const FEATURE_TABS = ["spec", "plan", "tasks", "checks", "runs", "gates"] as const;
export type FeatureTab = (typeof FEATURE_TABS)[number];

/** One card: a 34b flow with the Spec Kit folder it wrote, or a folder no flow made (written by hand, or merged). */
export interface FeatureItem {
  /** Stable across reloads: the flow's task, or the folder and its branch. */
  key: string;
  project: string;
  title: string;
  flow: SdlcFlow | null;
  spec: SpecFeature | null;
  /** The tasks the flow gave to agents (34c). */
  tasks: SdlcFlowTask[];
  column: FeatureColumn;
  /** Gates of the flow and of its tasks that wait for a person now. */
  waiting: SdlcGateRecord[];
  updatedAt: string;
}

export const isWaiting = (g: SdlcGateRecord | null | undefined): g is SdlcGateRecord => !!g && (g.status === "waiting" || g.status === "escalated");

/** Stages where a flow's task is still being built: a run, or a fix, is on it or about to be. */
const BUILDING = new Set<SdlcFlowTask["stage"]>(["queued", "build", "fixnext", "fix", "stopped"]);

/** Where a flow is on the board: its Spec Kit step until its tasks went out, then where those tasks are. */
export function flowColumn(flow: SdlcFlow, tasks: SdlcFlowTask[]): FeatureColumn {
  if (flow.step === "specify") return "spec";
  if (flow.step === "plan") return "plan";
  if (flow.step === "tasks" || flow.step === "import") return "tasks";
  if (!tasks.length) return flow.state === "done" ? "done" : "doing";
  if (tasks.some((x) => BUILDING.has(x.stage))) return "doing";
  return tasks.every((x) => x.stage === "done") ? "done" : "review";
}

/** A folder no flow drives: its stage, as the Spec page showed it. */
const STAGE_COLUMN: Record<SpecFeature["stage"], FeatureColumn> = { specify: "spec", plan: "plan", tasks: "tasks", implement: "doing", done: "done" };

const specKey = (f: Pick<SpecFeature, "project" | "dir" | "branch">) => `spec:${f.project}:${f.dir}:${f.branch}`;
const flowKey = (f: Pick<SdlcFlow, "project" | "taskId">) => `flow:${f.project}:${f.taskId}`;

/** A flow's own task title, without the "Spec: " specs.runStep put before it. */
const flowTitle = (flow: SdlcFlow, titles: Map<string, string>) => titles.get(`${flow.project}:${flow.taskId}`)?.replace(/^Spec:\s*/, "") || flow.taskId;

/**
 * The cards: every flow, with the folder it wrote (on its own branch ai/<task>, else on the target branch once
 * merged), then every other folder. A loose task with no flow is not a feature: it stays on Task.
 */
export function featureItems(flows: SdlcFlow[], specs: SpecFeature[], flowTasks: SdlcFlowTask[], tasks: Pick<Task, "project" | "id" | "title">[] = []): FeatureItem[] {
  const titles = new Map(tasks.map((x) => [`${x.project}:${x.id}`, x.title]));
  const used = new Set<string>();
  const items: FeatureItem[] = [];
  for (const flow of flows) {
    const branch = `ai/${flow.taskId}`;
    // The hub sets flow.dir only once the specify gate passes (#releaseFlows): until then the folder is the one
    // pushed on the flow's branch, found the same way (exactly one), or the person at the spec gate sees no spec.md.
    const onBranch = flow.dir ? [] : specs.filter((s) => s.project === flow.project && s.branch === branch);
    const dir = flow.dir ?? (onBranch.length === 1 ? onBranch[0]!.dir : null);
    const mine = dir ? specs.filter((s) => s.project === flow.project && s.dir === dir) : [];
    const spec = mine.find((s) => s.branch === branch) ?? mine.find((s) => s.branch === "") ?? null;
    if (spec) used.add(specKey(spec));
    const own = flowTasks.filter((x) => x.project === flow.project && x.flowTask === flow.taskId);
    const waiting = [...(flow.state === "gate" && isWaiting(flow.gate) ? [flow.gate] : []), ...own.flatMap((x) => (x.stage === "gate" && isWaiting(x.gate) ? [x.gate] : []))];
    const updatedAt = [flow.updatedAt, ...own.map((x) => x.updatedAt)].sort().at(-1)!;
    items.push({ key: flowKey(flow), project: flow.project, title: spec?.title ?? flowTitle(flow, titles), flow, spec, tasks: own, column: flowColumn(flow, own), waiting, updatedAt });
  }
  for (const spec of specs) {
    if (used.has(specKey(spec))) continue;
    items.push({ key: specKey(spec), project: spec.project, title: spec.title, flow: null, spec, tasks: [], column: STAGE_COLUMN[spec.stage], waiting: [], updatedAt: spec.pushedAt });
  }
  // What moved last on top of its column.
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Whether the person may decide at a gate, as the hub checks sdlc.decide (packages/core/src/sqlite.ts). */
export function mayDecide(allow: (project: string, need: Permission) => boolean, gate: Pick<SdlcGateRecord, "project" | "gate">): boolean {
  if (gate.gate === "test") return allow(gate.project, "qaVerify");
  if (gate.gate === "review" || gate.gate === "merge") return allow(gate.project, "codeReview");
  if (gate.gate === "tasks") return allow(gate.project, "runDispatch") && allow(gate.project, "taskManage");
  return allow(gate.project, "runDispatch");
}

/** The tab whose content a gate decides on, so its buttons sit next to what is read. */
export const gateTab = (gate: Pick<SdlcGateRecord, "gate">): FeatureTab => gate.gate === "test" ? "checks" : gate.gate === "spec" ? "spec" : gate.gate === "plan" ? "plan" : "tasks";

/** Whether a person's note is needed to ask for changes: the agent does the step again by it. */
export const noteRequired = (gate: Pick<SdlcGateRecord, "gate">): boolean => gate.gate !== "fix" && gate.gate !== "merge";

/** The address of a card's page: a flow by its task, a folder by where it was read. */
export function featureHref(item: Pick<FeatureItem, "project" | "flow" | "spec">): string {
  const q = new URLSearchParams({ project: item.project });
  if (item.flow) q.set("flow", item.flow.taskId);
  else if (item.spec) {
    q.set("dir", item.spec.dir);
    q.set("branch", item.spec.branch);
  }
  return `#/features?${q}`;
}

/**
 * The card an address names: `flow=` its flow, or `dir=`/`branch=` (the Spec page's links, #/specs?project&dir&branch)
 * the folder, which may be a flow's.
 */
export function findFeature(items: FeatureItem[], link: { project: string | null; flow: string | null; dir: string | null; branch: string | null }): FeatureItem | null {
  if (!link.project) return null;
  const mine = items.filter((x) => x.project === link.project);
  if (link.flow) return mine.find((x) => x.flow?.taskId === link.flow) ?? null;
  if (link.dir === null) return null;
  return mine.find((x) => x.spec?.dir === link.dir && x.spec.branch === (link.branch ?? "")) ?? null;
}

/** The tasks whose runs and gates are a feature's: the flow's own, its tasks', or for a folder its branch's and S001-…. */
export function featureTaskIds(item: Pick<FeatureItem, "flow" | "spec" | "tasks">): { ids: Set<string>; prefix: string | null } {
  const ids = new Set<string>();
  if (item.flow) ids.add(item.flow.taskId);
  for (const x of item.tasks) ids.add(x.taskId);
  const ai = item.spec ? /^ai\/(.+)$/.exec(item.spec.branch)?.[1] : undefined;
  if (ai) ids.add(ai);
  return { ids, prefix: item.spec ? `${specTaskPrefix(item.spec.dir)}-` : null };
}

export const ownsTask = (owned: ReturnType<typeof featureTaskIds>, taskId: string): boolean => owned.ids.has(taskId) || (!!owned.prefix && taskId.startsWith(owned.prefix));

// ── Kiểm thử ──────────────────────────────────────────────────────────────────

/** "done": the criteria the feature is done by (Xong khi); "check": a scenario or checklist line to try. */
export type CheckGroup = "done" | "check";
export interface CheckItem {
  id: string;
  group: CheckGroup;
  text: string;
  /** The user story or section it is under, when there is one. */
  under: string | null;
  /** Ticked in spec.md itself ("- [x]"). */
  inFile: boolean;
}

const DONE_HEADING = /success criteria|measurable outcomes|done when|definition of done|acceptance criteria|xong khi|tiêu chí/i;
const CHECK_HEADING = /checklist|kiểm thử|kịch bản|test scenarios?|acceptance scenarios?/i;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/;

const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\s+/g, " ").trim();
const heading = (s: string) => plain(s.replace(/^#+\s+/, "").replace(/\*\(.*?\)\*/g, ""));

/** A short id for a line that has none of its own, the same for the same words. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * What a spec.md says the feature is done by and how to try it, as Spec Kit's template writes them: the list under
 * "Success Criteria" (SC-001…) is Xong khi; the lines after "**Acceptance Scenarios**:" in each user story, a section
 * named checklist or kiểm thử, and any "- [ ]" line are the checklist. Code blocks are left out.
 */
export function featureChecks(spec: string | null): CheckItem[] {
  const out: CheckItem[] = [];
  const seen = new Set<string>();
  let section: CheckGroup | null = null;
  let story: string | null = null;
  let scenarios = false;
  let fenced = false;
  for (const line of (spec ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^(#{1,6})\s/.exec(line);
    if (h) {
      const name = heading(line);
      const level = h[1]!.length;
      scenarios = false;
      if (DONE_HEADING.test(name)) section = "done";
      else if (CHECK_HEADING.test(name)) section = "check";
      // A sub-heading (### Measurable Outcomes) stays in the section above it; another ## leaves it.
      else if (level <= 2) section = null;
      story = level >= 3 ? name : null;
      continue;
    }
    const label = /^\s*\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
    if (label) {
      // "**Acceptance Scenarios**:" opens the list below it; any other label ("**Independent Test**:") closes it.
      scenarios = CHECK_HEADING.test(label[1]!);
      if (DONE_HEADING.test(label[1]!)) section = "done";
      continue;
    }
    const m = ITEM.exec(line);
    if (!m) continue;
    const box = m[1];
    const group: CheckGroup | null = section === "done" ? "done" : scenarios || section === "check" || box !== undefined ? "check" : null;
    if (!group) continue;
    const text = plain(m[2]!);
    if (!text) continue;
    const own = /^((?:SC|AC|TC|FR)-\d+)\b/.exec(text)?.[1];
    let id = own ?? `${group}-${hash(`${story ?? ""}|${text}`)}`;
    while (seen.has(id)) id = `${id}'`;
    seen.add(id);
    out.push({ id, group, text, under: group === "check" ? story : null, inFile: box === "x" || box === "X" });
  }
  return out;
}

/** Marks are kept in this browser (localStorage), per feature folder: an item's id → when it was ticked. */
export type CheckMarks = Record<string, string>;
export const checksKey = (project: string, dir: string): string => `xdev-hive.checks:${project}/${dir}`;

export function readChecks(key: string, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): CheckMarks {
  try {
    const value: unknown = JSON.parse(storage?.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === "string"));
  } catch {
    return {};
  }
}

export function writeChecks(key: string, marks: CheckMarks, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage): void {
  try {
    if (Object.keys(marks).length) storage?.setItem(key, JSON.stringify(marks));
    else storage?.removeItem(key);
  } catch {
    // A private browser keeps the marks for this visit only.
  }
}

/** How many of the items are ticked, here or in the file. */
export const checkedCount = (items: CheckItem[], marks: CheckMarks): number => items.filter((x) => x.inFile || marks[x.id]).length;
