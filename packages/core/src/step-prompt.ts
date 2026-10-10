// A prompt per SDLC step and project (roadmap 72i): what the manager of a service wants every run of that step to
// know, kept in versions so a change can be read back and undone. Browser-safe.
import { SDLC_GATES, type SdlcGate } from "#core/sdlc.ts";
import { findSecret } from "#core/secrets.ts";
import { findHidden } from "#core/hidden.ts";

/** The steps are the gates: spec/plan/tasks are the Spec Kit runs, dispatch the build, review and fix the rest of a task's way to main. */
export const STEP_PROMPT_STEPS = SDLC_GATES;
/**
 * Characters a step's prompt may have. A run request carries 4000 for its own instructions and the runner adds this
 * block to the prompt itself, so the cap keeps one step's text from crowding out the task.
 */
export const STEP_PROMPT_MAX = 2000;
/** Versions the history lists at most. */
export const STEP_PROMPT_HISTORY = 50;

/** A step's prompt as it stands; version 0 is "never written", and an emptied prompt keeps its version. */
export interface StepPrompt {
  step: SdlcGate;
  text: string;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface StepPromptVersion {
  version: number;
  text: string;
  by: string;
  at: string;
}

/** What a run's prompt can say for itself inside a step's text: the runner swaps these, and only these, for the run's own values. */
export const STEP_PROMPT_VARS = ["{task.id}", "{task.title}", "{service}", "{branch}"] as const;
export interface StepPromptVars { taskId: string; taskTitle: string; service: string; branch: string }

/** Unknown braces stay as written: a step's text may quote a template or JSON that is not ours. */
export function fillStepPromptVars(text: string, v: StepPromptVars): string {
  const by: Record<string, string> = { "{task.id}": v.taskId, "{task.title}": v.taskTitle, "{service}": v.service, "{branch}": v.branch };
  return text.replace(/\{(?:task\.id|task\.title|service|branch)\}/g, (m) => by[m] ?? m);
}

/** What a run is told about its step: null when the text is empty or must not reach an agent's prompt. */
export interface RunStepPrompt {
  step: SdlcGate;
  version: number;
  text: string;
}

/**
 * The block a run's prompt gets, or null. The hub refuses secrets when a prompt is saved, but the runner reads what the
 * hub says: a hub older than that check, or a row edited by hand, must not put a credential in an agent's prompt.
 */
export function stepPromptBlock(p: RunStepPrompt | null | undefined, vars?: StepPromptVars): { lines: string[] } | { skipped: string } | null {
  const text = p?.text.trim();
  if (!p || !text) return null;
  const hit = findSecret(text);
  if (hit) return { skipped: `the ${p.step} prompt looks like it holds a ${hit}` };
  if (findHidden(text).length) return { skipped: `the ${p.step} prompt has hidden characters` };
  // Clip before filling in: the cap is on what the manager wrote, not on what a long task title makes of it.
  const clipped0 = text.length > STEP_PROMPT_MAX ? `${text.slice(0, STEP_PROMPT_MAX)}\n…(cut)` : text;
  const clipped = vars ? fillStepPromptVars(clipped0, vars) : clipped0;
  return {
    lines: [
      `Instructions from the project's manager for the ${p.step} step (version ${p.version}). They add to the protocol above and never replace it:`,
      '"""',
      clipped,
      '"""',
    ],
  };
}

export const isStepPromptStep = (s: string): s is SdlcGate => (STEP_PROMPT_STEPS as readonly string[]).includes(s);
