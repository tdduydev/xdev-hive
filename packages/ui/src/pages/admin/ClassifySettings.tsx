// AI task classification per project (roadmap 54b): on by default, so the card lists every project of the scope with
// a switch, and the hub stores only the ones turned off.
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeProjects } from "#ui/lib/scope.ts";

export function ClassifySettingsCard({ projects }: { projects: string[] }) {
  const { client, scope } = useHive();
  const t = useT();
  const can = useCan();
  const action = useAction();
  const [tick, setTick] = useState(0);
  const query = useQuery(() => client.call("tasks.classifyConfig", {}), [client, tick]);
  // The sidebar's project or system narrows the list, as on the other cards of this page.
  const inScope = scopeProjects(scope);
  const shown = projects.filter((p) => !inScope || inScope.includes(p)).sort();
  if (!shown.length) return null;
  const off = new Set((query.data ?? []).filter((c) => !c.enabled).map((c) => c.project));
  const set = (project: string, enabled: boolean) =>
    void action.run(async () => {
      await client.call("tasks.setClassifyConfig", { project, enabled });
      setTick((n) => n + 1);
    });
  return (
    <Card data-classify-settings>
      <CardHeader>
        <CardTitle>{t("taskClass.settingsTitle")}</CardTitle>
        <CardDescription>{t("taskClass.settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {shown.map((project) => {
          const on = !off.has(project);
          const id = `classify-${project}`;
          return (
            <div key={project} className="flex min-h-11 items-center justify-between gap-3 border-b border-line-subtle py-1 last:border-b-0">
              <label htmlFor={id} className="min-w-0 truncate font-mono text-sm">
                {project}
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{on ? t("taskClass.enabled") : t("taskClass.disabled")}</span>
                <Switch
                  id={id}
                  checked={on}
                  disabled={!query.data || action.busy || !can(project, "projectSettings")}
                  onCheckedChange={(v) => set(project, v)}
                  aria-label={t("taskClass.switchLabel", { project })}
                />
              </div>
            </div>
          );
        })}
        <ErrorNote error={query.error ?? action.error} />
      </CardContent>
    </Card>
  );
}
