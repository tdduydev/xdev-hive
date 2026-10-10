// How a run's prompt is put together (roadmap 72i), from the top down. The runner's buildPrompt and the Prompt tab's
// preview both take these pieces from here, so what a manager reads on the page is what the agent is told. Browser-safe.
import { ARTIFACT_DIR } from "#core/artifacts.ts";
import type { AgentRole } from "#core/agents.ts";
import type { SdlcGate } from "#core/sdlc.ts";
import { stepPromptBlock, type RunStepPrompt, type StepPromptVars } from "#core/step-prompt.ts";

/** Said last, to every run but the judge's. */
export const STEER_PROMPT = "Read .xdev-hive/steer.md after each step and before your final report for additional instructions from the person directing this run. Apply new messages in order, once each. Do not edit or commit that file.";

/** The order buildPrompt appends them in; only `step` is the project's manager's to write. */
export const PROMPT_LAYERS = ["frame", "repo", "artifacts", "task", "step", "admin", "steer"] as const;
export type PromptLayerId = (typeof PROMPT_LAYERS)[number];

/**
 * The runs an agent gets and the steps of the flow each one belongs to. Saved per step because one role is several steps
 * (an implement run writes the spec, the plan, the tasks, builds, or fixes); research and the judge have a frame of their own
 * and take no step prompt; test, merge and release are done by the engine today, their prompt waits for a run that takes it.
 */
export const PROMPT_ROLES = [
  { role: "implement", steps: ["spec", "plan", "tasks", "dispatch", "fix"] },
  { role: "review", steps: ["review"] },
  { role: "research", steps: [] },
  { role: "judge", steps: [] },
  { role: "test", steps: ["test"] },
  { role: "merge", steps: ["merge", "release"] },
] as const satisfies readonly { role: string; steps: readonly SdlcGate[] }[];
export type PromptRole = (typeof PROMPT_ROLES)[number]["role"];
/** Roles whose runs read the step prompt today. */
export const PROMPT_ROLES_WIRED: readonly PromptRole[] = ["implement", "review"];

export interface FrameContext {
  project: string;
  taskId: string;
  title: string;
  role: AgentRole;
  worktree: string;
  branch: string;
  baseSha: string;
  /** The profile is read-only: the agent has Hive's read tools only. */
  readOnly?: boolean;
  /** Claude and Codex load AGENTS.md themselves. */
  agentKind?: string;
  /** A best-of-n candidate: n of `of`. */
  candidate?: { n: number; of: number } | null;
}

/** The opening of a run's prompt (not the judge's): task and run-specific handoff. */
export function frameLines(c: FrameContext): string[] {
  const lines: string[] = [];
  const readAgents = c.agentKind === "claude" || c.agentKind === "codex" ? [] : ["Follow AGENTS.md in the working copy for project conventions and the Hive agent protocol."];
  if (c.role === "review") {
    lines.push(
      `Review the work for task ${c.taskId} of project "${c.project}" (xDev Hive): ${c.title}`,
      "",
      `Working copy: ${c.worktree} (branch ${c.branch}). See the change with: git diff ${c.baseSha}...HEAD`,
      "",
      ...readAgents,
      "Look for bugs, regressions, missing tests and risky changes. Do not rewrite the feature;",
      "fix only small, obvious mistakes. End your report with exactly one standalone line: `Verdict: approve` if no findings block the review, or `Verdict: changes` if changes are needed. Put findings before that line.",
      c.readOnly
        ? "xDev Hive is read-only for this run: put reusable lessons in your report. Do not change the task status."
        : "Do not call task_claim or task_update: the implementer owns this task. Record reusable lessons in the handoff.",
    );
    return lines;
  }
  lines.push(
    `You are working on task ${c.taskId} of project "${c.project}" (xDev Hive).`,
    `Task: ${c.title}`,
    "",
    `Working copy: ${c.worktree} (git worktree on branch ${c.branch}, based on ${c.baseSha.slice(0, 10)}). Stay inside it.`,
  );
  if (c.role === "plan") {
    lines.push("", "This is a planning run: write the plan to docs/plans/" + c.taskId + ".md. Do not implement yet.");
  }
  lines.push("", ...readAgents);
  if (c.readOnly) {
    lines.push("xDev Hive is read-only for this run. Do not change task status; include decisions and gotchas in your handoff note.");
  } else if (c.candidate) {
    lines.push("This is a candidate run. Do not call task_update; include what changed, verification, and risks in your handoff note.");
  } else {
    lines.push(`At handoff, call task_update ${c.taskId} to "review" with a note covering changes, verification, and risks.`);
  }
  lines.push("Do not push. Uncommitted changes are committed to this branch for you when you exit.");
  return lines;
}

/** What a hub's run is told about the files it leaves behind. */
export function artifactLines(taskId: string, role: AgentRole): string[] {
  return [
    `A file worth keeping that is not code (a screenshot, a report, a measurement${role === "plan" ? ", the plan" : ""}): write it in ${ARTIFACT_DIR}/ of the working copy.`,
    `That folder stays out of the commit; when this run ends the files go to xDev Hive, beside this run and task ${taskId}, and other agents read them with artifact_list and artifact_get.`,
    "At most 20 files, 5 MB each; png, jpg, webp and pdf, or text as md, txt, json and log. Never put a secret in one.",
  ];
}

export interface PromptPreviewInput {
  role: PromptRole;
  /** CLI kind selected for this sample; it controls the same frame condition as the runner. */
  agentKind: string;
  project: string;
  task: { id: string; title: string; note: string | null };
  branch: string;
  /** The step's prompt as it would be saved (a draft, or the version on the hub). */
  step: RunStepPrompt | null;
}

export interface PromptLayer {
  id: PromptLayerId;
  /** The words the agent is told; "" when this layer says nothing for the sample, null when it depends on the working copy or the run's request. */
  text: string | null;
  /** The step's text is held back from the prompt, and why (a secret, hidden characters). */
  skipped?: string;
}

/**
 * The layers of a run's prompt for a sample task, top to bottom. Joined with a blank line between those with words they
 * are what buildPrompt gives for a run in a hub with no AGENTS.md skills, rules or extra instructions to add. The
 * working copy's own files and the admin's extra instructions are not known here: their text is null.
 */
export function promptPreview(i: PromptPreviewInput): PromptLayer[] | null {
  if (i.role === "research" || i.role === "judge") return null;
  const role: AgentRole = i.role === "review" ? "review" : "implement";
  const vars: StepPromptVars = { taskId: i.task.id, taskTitle: i.task.title, service: i.project, branch: i.branch };
  const block = stepPromptBlock(i.step, vars);
  return [
    { id: "frame", text: frameLines({ project: i.project, taskId: i.task.id, title: i.task.title, role, worktree: "<working copy>", branch: i.branch, baseSha: "<base commit>", agentKind: i.agentKind }).join("\n") },
    { id: "repo", text: null },
    { id: "artifacts", text: artifactLines(i.task.id, role).join("\n") },
    { id: "task", text: i.task.note ? ["Latest note on the task:", i.task.note].join("\n") : "" },
    block && "skipped" in block ? { id: "step", text: "", skipped: block.skipped } : { id: "step", text: block ? block.lines.join("\n") : "" },
    { id: "admin", text: null },
    { id: "steer", text: STEER_PROMPT },
  ];
}
