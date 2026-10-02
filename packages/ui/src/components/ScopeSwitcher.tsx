import { ChevronsUpDown } from "lucide-react";
import { cn } from "cn";
import { ProjectPicker } from "#ui/components/ProjectPicker.tsx";
import { useHive } from "#ui/hooks.ts";
import { useT, type MessageKey } from "#ui/i18n/index.tsx";
import { scopeLabel, type Scope } from "#ui/lib/scope.ts";

const HINT: Record<Exclude<Scope["kind"], "system">, MessageKey> = { all: "scope.allHint", shared: "scope.sharedHint", project: "scope.projectHint" };
const badge = (scope: Scope) => scope.kind === "all" ? "ALL" : scopeLabel(scope).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase();

/** The sidebar's current scope remains the source of filtering for every page. */
export function ScopeSwitcher() {
  const { scope, setScope, projects, systems } = useHive();
  const t = useT();
  const hint = scope.kind === "system" ? t("scope.systemHint", { count: scope.projects.length }) : t(HINT[scope.kind]);
  return <ProjectPicker mode="scope" value={scope} onChange={setScope} projects={projects} systems={systems} triggerTitle={hint} manageSystems={() => { window.location.hash = "#/systems"; }} trigger={<>
    <span className="grid size-[22px] shrink-0 place-items-center rounded-[5px] bg-selected font-mono text-[9px]/none font-bold text-selected-fg">{badge(scope)}</span>
    <span className={cn("min-w-0 flex-1 truncate text-[13px]/none font-semibold", scope.kind === "project" && "font-mono text-xs")}>{scopeLabel(scope)}</span>
    <ChevronsUpDown className="size-3.5 shrink-0 text-fg-muted" />
  </>} />;
}
