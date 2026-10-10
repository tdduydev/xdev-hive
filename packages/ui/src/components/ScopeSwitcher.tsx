import { ChevronsUpDown } from "lucide-react";
import { cn } from "cn";
import { ProjectPicker } from "#ui/components/ProjectPicker.tsx";
import { useHive } from "#ui/hooks.ts";
import { useT, type MessageKey } from "#ui/i18n/index.tsx";
import { settingsTabs, webCaps } from "#ui/lib/nav.ts";
import { scopeTitle, type Scope } from "#ui/lib/scope.ts";
import scopePlanet from "#ui/assets/cosmic/planet-blue.png";

const HINT: Record<Exclude<Scope["kind"], "system">, MessageKey> = { all: "scope.allHint", shared: "scope.sharedHint", project: "scope.projectHint" };

/** The sidebar's current scope remains the source of filtering for every page. */
export function ScopeSwitcher() {
  const { client, me, scope, setScope, projects, systems } = useHive();
  const t = useT();
  const hint = scope.kind === "system" ? t("scope.systemHint", { count: scope.projects.length }) : t(HINT[scope.kind]);
  // On the web Hệ thống is a tab of Cài đặt dự án (roadmap 49b), which not everyone has: no link that lands elsewhere.
  const manage = client.desktop || settingsTabs(me, projects, webCaps(client)).includes("systems");
  return <ProjectPicker mode="scope" value={scope} onChange={setScope} projects={projects} systems={systems} triggerTitle={hint} manageSystems={manage ? () => { window.location.hash = "#/systems"; } : undefined} trigger={<>
    <img src={scopePlanet} alt="" className="size-7 shrink-0 rounded-full" />
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="hive-scope-caption">{t("shell.scope")}</span>
      <span className={cn("min-w-0 truncate text-[13px]/[18px] font-semibold", scope.kind === "project" && "font-mono")}>{scopeTitle(scope, systems)}</span>
    </span>
    <ChevronsUpDown className="size-3.5 shrink-0 text-fg-muted" />
  </>} />;
}
