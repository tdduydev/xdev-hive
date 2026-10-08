// Spec Kit features (roadmap 20b): what the Spec page shows of specs/<NNN-name>/ in a project's repo. Browser-safe.

/** The files of a feature the page reads: spec.md, plan.md, tasks.md. */
export const SPEC_FILES = ["spec", "plan", "tasks"] as const;
export type SpecFile = (typeof SPEC_FILES)[number];
export const SPEC_STAGES = ["specify", "plan", "tasks", "implement", "done"] as const;
export type SpecStage = (typeof SPEC_STAGES)[number];
/** At most this many features per push, and characters per file. */
export const SPEC_FEATURES_MAX = 100;
export const SPEC_FILE_MAX = 200_000;
/** A feature's folder under specs/. */
export const SPEC_DIR = /^[\w.-]{1,100}$/;

export interface SpecFiles {
  spec: string | null;
  plan: string | null;
  tasks: string | null;
}

export interface SpecFeature {
  project: string;
  /** "001-dang-nhap-sso": the folder's name under specs/. */
  dir: string;
  /** "" = the project's target branch; else the branch it was read from (ai/SPEC-1, 002-xuat-bao-cao). */
  branch: string;
  /** From spec.md, without "Feature Specification:"; the folder's name when there is none. */
  title: string;
  stage: SpecStage;
  tasksDone: number;
  tasksTotal: number;
  /** SHA of the ref that was read; older machines may report an abbreviated SHA. */
  commit: string;
  /** The machine that pushed it. */
  machine: string;
  pushedAt: string;
}

export interface SpecFeatureDetail extends SpecFeature {
  files: SpecFiles;
}

export function specTitle(spec: string | null, dir: string): string {
  const line = spec?.split("\n").find((l) => /^#\s/.test(l));
  const title = line
    ?.replace(/^#\s+/, "")
    .replace(/^Feature Specification:\s*/i, "")
    .trim();
  return title || dir;
}

/** Counts the task lines "- [ ] T001 …" and "- [x] …" (also "* [X]"), wherever they are in the file. */
export function specTasks(tasks: string | null): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const line of (tasks ?? "").split("\n")) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== " ") done++;
  }
  return { done, total };
}

export function specStage(files: SpecFiles): SpecStage {
  if (files.plan === null) return "specify";
  if (files.tasks === null) return "plan";
  const { done, total } = specTasks(files.tasks);
  if (done === 0) return "tasks";
  return done < total ? "implement" : "done";
}

// ── tasks.md into board tasks (roadmap 20c, docs/specs/20-speckit.md) ──────────

export type SpecPhaseKind = "setup" | "foundational" | "story" | "polish" | "other";

export interface SpecTaskLine {
  /** T001 */
  code: string;
  done: boolean;
  /** [P]: may run beside the [P] tasks next to it. */
  parallel: boolean;
  /** [US1] */
  story: string | null;
  /** The description, [P] and [USn] taken out. */
  text: string;
  /** Codes named in "depends on T012, T013". */
  named: string[];
  phase: number;
  phaseTitle: string;
  phaseKind: SpecPhaseKind;
}

const phaseKind = (title: string): SpecPhaseKind =>
  /setup/i.test(title) ? "setup" : /foundation/i.test(title) ? "foundational" : /user story/i.test(title) ? "story" : /polish/i.test(title) ? "polish" : "other";

/** The task lines of a tasks.md, in order, with their phase. Code blocks and HTML comments (the template's examples) are left out. */
export function parseSpecTasks(md: string): SpecTaskLine[] {
  const out: SpecTaskLine[] = [];
  let phase = 0;
  let phaseTitle = "";
  let inCode = false;
  const text = md.replace(/<!--[\s\S]*?-->/g, "");
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inCode = !inCode;
    if (inCode) continue;
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h && !line.startsWith("###")) {
      phase++;
      phaseTitle = h[1]!.replace(/^Phase\s+\w+:\s*/i, "").trim() || h[1]!;
      continue;
    }
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(T\d{1,5})\b\s*(.*)$/.exec(line);
    if (!m) continue;
    let rest = m[3]!;
    const parallel = /\[P\]/.test(rest);
    const story = /\[(US\d+)\]/.exec(rest)?.[1] ?? null;
    rest = rest.replace(/\[P\]/g, "").replace(/\[US\d+\]/g, "").replace(/\s+/g, " ").trim();
    const dep = /depends on ((?:T\d{1,5}(?:\s*(?:,|and)\s*)?)+)/i.exec(rest);
    const named = dep ? [...dep[1]!.matchAll(/T\d{1,5}/g)].map((x) => x[0]) : [];
    out.push({ code: m[2]!, done: m[1] !== " ", parallel, story, text: rest, named, phase, phaseTitle, phaseKind: phaseKind(phaseTitle) });
  }
  return out;
}

export interface SpecTaskPlan {
  code: string;
  /** <prefix>-T001 */
  id: string;
  title: string;
  phase: string;
  /** Ids of the tasks it waits for, the ones already done in tasks.md left out. */
  dependsOn: string[];
  done: boolean;
}

/** The task id prefix a feature folder suggests: "001-dang-nhap" → "S001". */
export const specTaskPrefix = (dir: string): string => `S${/^(\d+)/.exec(dir)?.[1] ?? dir.slice(0, 8).replace(/[^A-Za-z0-9]/g, "")}`;

/** A Hive task may wait for at most this many. */
const MAX_DEPS = 20;

/**
 * Board tasks for a tasks.md, as its template orders the work: steps in a phase follow each other (a run of [P] tasks
 * is one step), a phase starts after its gate (Setup → Foundational → each user story, stories side by side → Polish
 * after every story; another phase after the one before), plus what a line names with "depends on".
 */
export function planSpecTasks(md: string, prefix: string): { tasks: SpecTaskPlan[]; warnings: string[] } {
  const lines = parseSpecTasks(md);
  const id = (code: string) => `${prefix}-${code}`;
  const warnings: string[] = [];
  // The steps of each phase, in order.
  const phases = new Map<number, { kind: SpecPhaseKind; title: string; steps: SpecTaskLine[][] }>();
  for (const l of lines) {
    const p = phases.get(l.phase) ?? { kind: l.phaseKind, title: l.phaseTitle, steps: [] };
    const last = p.steps.at(-1);
    if (l.parallel && last?.every((x) => x.parallel)) last.push(l);
    else p.steps.push([l]);
    phases.set(l.phase, p);
  }
  const order = [...phases.keys()].sort((a, b) => a - b);
  const lastStep = (n: number | undefined) => (n === undefined ? [] : (phases.get(n)?.steps.at(-1) ?? []));
  const gateOf = (n: number): SpecTaskLine[] => {
    const at = order.indexOf(n);
    const before = order.slice(0, at);
    const kind = phases.get(n)!.kind;
    const find = (k: SpecPhaseKind) => before.filter((b) => phases.get(b)!.kind === k).at(-1);
    if (kind === "setup") return [];
    if (kind === "foundational") return lastStep(find("setup") ?? before.at(-1));
    if (kind === "story") return lastStep(find("foundational") ?? find("setup") ?? before.filter((b) => phases.get(b)!.kind !== "story").at(-1));
    if (kind === "polish") {
      const stories = before.filter((b) => phases.get(b)!.kind === "story");
      return stories.length ? stories.flatMap((s) => lastStep(s)) : lastStep(before.at(-1));
    }
    return lastStep(before.at(-1));
  };
  const known = new Set(lines.map((l) => l.code));
  const done = new Set(lines.filter((l) => l.done).map((l) => l.code));
  const tasks: SpecTaskPlan[] = [];
  for (const n of order) {
    const p = phases.get(n)!;
    p.steps.forEach((step, i) => {
      const before = i === 0 ? gateOf(n) : p.steps[i - 1]!;
      for (const l of step) {
        let deps = [...new Set([...before.map((b) => b.code), ...l.named.filter((c) => known.has(c) && c !== l.code)])].filter((c) => !done.has(c));
        if (deps.length > MAX_DEPS) {
          warnings.push(`${l.code}: ${deps.length} > ${MAX_DEPS}`);
          deps = deps.slice(0, MAX_DEPS);
        }
        const title = `${l.code}${l.story ? ` [${l.story}]` : ""} ${l.text}`.slice(0, 300);
        tasks.push({ code: l.code, id: id(l.code), title, phase: p.title, dependsOn: deps.map(id), done: l.done });
      }
    });
  }
  return { tasks, warnings };
}

// ── runs for the Spec Kit steps (roadmap 20d) ─────────────────────────────────

export const SPEC_STEPS = ["specify", "plan", "tasks"] as const;
export type SpecStep = (typeof SPEC_STEPS)[number];

/** The step that moves a feature on: plan after its spec, tasks after its plan; none once it has tasks. */
export const specNextStep = (stage: SpecStage): SpecStep | null => (stage === "specify" ? "plan" : stage === "plan" ? "tasks" : null);

/**
 * The task a step of a feature runs as. A feature on a run's branch (ai/<task>) goes on in that task, so the run is on the
 * same branch and finds what the steps before wrote; one on the target branch gets a task of its own, whose branch starts
 * there. A branch someone made by hand: none (merge it first).
 */
export function specRunTask(f: Pick<SpecFeature, "dir" | "branch" | "title">, step: SpecStep, has: (id: string) => boolean): { taskId: string; title: string | null } | null {
  const ai = /^ai\/(.+)$/.exec(f.branch)?.[1];
  if (ai) return has(ai) ? { taskId: ai, title: null } : null;
  if (f.branch) return null;
  const taskId = `${specTaskPrefix(f.dir)}-${step.toUpperCase()}`;
  const name = step === "plan" ? "Plan" : step === "tasks" ? "Tasks" : "Spec";
  return { taskId, title: has(taskId) ? null : `${name}: ${f.title}`.slice(0, 300) };
}

/** The next free SPEC-<n> of a project's tasks, for a new feature. */
export function nextSpecTaskId(ids: readonly string[]): string {
  const n = Math.max(0, ...ids.map((id) => Number(/^SPEC-(\d+)$/.exec(id)?.[1] ?? 0)));
  return `SPEC-${n + 1}`;
}

/**
 * What the agent is told for one Spec Kit step: the skill Spec Kit installed in the repo (Claude Code's or Codex's), the
 * person's input, the feature's folder for the Spec Kit scripts, and to stop at the spec files.
 */
export function specStepInstructions(step: SpecStep, o: { dir?: string; input?: string } = {}): string {
  const skill = `speckit-${step}`;
  const input = o.input?.trim();
  return [
    `Spec Kit step "${step}" ${o.dir ? `for the feature in specs/${o.dir}` : "for a new feature"}.`,
    `Read .claude/skills/${skill}/SKILL.md (Codex: .agents/skills/${skill}/SKILL.md) and do what it says${input ? ", with this input from the project's manager:" : "."}`,
    ...(input ? ["", input, ""] : []),
    ...(o.dir ? [`The feature's folder is specs/${o.dir}: run the Spec Kit scripts with SPECIFY_FEATURE_DIRECTORY=specs/${o.dir}.`] : []),
    "Only write the feature's Spec Kit files under specs/. Do not write code, and do not run the other Spec Kit steps.",
    "Commit them on the task's branch. In the handoff note, list the files you wrote and what is still open (questions, [NEEDS CLARIFICATION] marks).",
  ].join("\n");
}
