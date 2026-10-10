import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

/** Hub admins can turn the learned dispatch preference on per project without changing its model cells. */
export function CleanRateSettingsCard() {
  const { client, projects } = useHive();
  const t = useT();
  const action = useAction();
  const [tick, setTick] = useState(0);
  const query = useQuery(() => client.call("modelRouter.get", {}), [client, tick]);
  const set = (project: string, preferByCleanRate: boolean) => void action.run(async () => {
    const current = query.data?.projects[project] ?? { enabled: true, profile: "balanced" as const, cells: {}, preferByCleanRate: false };
    await client.call("modelRouter.set", { project, setting: { ...current, preferByCleanRate } });
    setTick((n) => n + 1);
  });
  return <Card data-admin-clean-rate>
    <CardHeader><CardTitle>{t("modelRouting.learning")}</CardTitle><CardDescription>{t("modelRouting.preferByCleanRateHint")}</CardDescription></CardHeader>
    <CardContent className="space-y-1">
      {[...projects].sort().map((project) => <div key={project} className="flex min-h-11 items-center justify-between gap-3 border-b border-line-subtle py-1 last:border-b-0">
        <label htmlFor={`clean-rate-${project}`} className="min-w-0 truncate font-mono text-sm">{project}</label>
        <Switch id={`clean-rate-${project}`} checked={query.data?.projects[project]?.preferByCleanRate ?? false}
          disabled={!query.data || action.busy} onCheckedChange={(value) => set(project, value)}
          aria-label={`${project}: ${t("modelRouting.preferByCleanRate")}`} data-clean-rate-project={project} />
      </div>)}
      <ErrorNote error={query.error ?? action.error} />
    </CardContent>
  </Card>;
}
