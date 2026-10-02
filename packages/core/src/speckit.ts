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
  /** Short sha of the ref that was read. */
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
