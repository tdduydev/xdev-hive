import type { ComponentType } from "react";
import { Bot, Cpu, GitBranch, ListChecks, Play, Settings2, SquareTerminal } from "lucide-react";
import type { DeskPage } from "./desk-nav.ts";

/** Kept apart from desk-nav.ts so that file stays free of React. */
export const DESK_ICONS: Record<DeskPage, ComponentType<{ className?: string }>> = {
  start: ListChecks,
  machine: Cpu,
  agents: Bot,
  runs: Play,
  worktrees: GitBranch,
  setup: SquareTerminal,
  settings: Settings2,
};
