import { AUTONOMY_FLAGS, type AgentProfile, type RunPlan } from "@xdev-hive/core";
import { withoutArrayFlags, withoutFlags } from "#desktop/main/runner/command.ts";

export function planningProfile(profile: AgentProfile): AgentProfile {
  if (!["claude", "codex", "gemini"].includes(profile.kind)) throw new Error("Plan approval requires Claude, Codex or Gemini.");
  const flags = AUTONOMY_FLAGS[profile.kind]!;
  let args = withoutFlags(profile.args, flags.valued, [...flags.switches, ...(profile.kind === "codex" ? ["--yolo"] : [])]);
  if (profile.kind === "codex") {
    // A profile/config override must not reopen the sandbox after the runner closed it.
    const sandboxOverride = (a: string) => /^\s*sandbox_mode\s*=/.test(a);
    args = args.filter((a, i, all) => {
      if ((a === "-c" || a === "--config") && sandboxOverride(all[i + 1] ?? "")) return false;
      if ((all[i - 1] === "-c" || all[i - 1] === "--config") && sandboxOverride(a)) return false;
      return !/^--config=\s*sandbox_mode\s*=/.test(a);
    });
    args = [...args, "-s", "read-only"];
  } else if (profile.kind === "gemini") args = [...withoutArrayFlags(args, ["--allowed-tools"]), "--approval-mode", "plan"];
  else args = [...args, "--permission-mode", "plan"];
  return { ...profile, args, readOnly: true };
}
export function planningPrompt(c: { project: string; taskId: string; title: string; note: string | null; instructions: string; worktree: string; plan: RunPlan }): string {
  return [
    `Only plan task ${c.taskId} in project ${c.project}: ${c.title}`,
    `Read the repository at ${c.worktree}, AGENTS.md and the task's referenced specs.`,
    "This is the read-only planning phase of an implement run. Only plan; do not implement, edit files, commit, push, claim the task or update Hive.",
    "Return only a short Markdown plan.md in your final response. The runner saves it, so do not write a file yourself.",
    "Include: work to do, files to change, verification, and risks. Follow the repository conventions.",
    "Task note (context):", c.note ?? "",
    "Manager instructions:", c.instructions,
    ...(c.plan.text ? ["Previous plan:", c.plan.text] : []),
    ...(c.plan.note ? ["Requested changes to the plan:", c.plan.note] : []),
  ].join("\n\n");
}
