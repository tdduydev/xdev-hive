import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useCan, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

export function ClassifySettingsCard({ projects }: { projects: string[] }) {
  const t = useT();
  return <Card>
    <CardHeader><CardTitle>{t("taskClass.settingsTitle")}</CardTitle></CardHeader>
    <CardContent className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t("taskClass.settingsDescription")}</p>
      {projects.map((project) => <ProjectClassifySetting key={project} project={project} />)}
    </CardContent>
  </Card>;
}

function ProjectClassifySetting({ project }: { project: string }) {
  const { client } = useHive();
  const t = useT();
  const can = useCan();
  const [tick, setTick] = useState(0);
  const query = useQuery(() => client.call("tasks.classifyConfig", { project }), [client, project, tick]);
  const action = useAction();
  return <div className="flex flex-wrap items-center gap-2 text-sm">
    <span className="min-w-32 font-medium">{project}</span>
    {query.data ? <NativeSelect size="sm" wrapperClassName="min-w-40" value={query.data.enabled ? "on" : "off"} disabled={!can(project, "projectSettings") || action.busy}
      aria-label={`${project} · ${t("taskClass.settingsTitle")}`} onChange={(e) => void action.run(async () => {
        await client.call("tasks.setClassifyConfig", { project, enabled: e.target.value === "on" });
        setTick((n) => n + 1);
      })}>
      <NativeSelectOption value="on">{t("taskClass.enabled")}</NativeSelectOption>
      <NativeSelectOption value="off">{t("taskClass.disabled")}</NativeSelectOption>
    </NativeSelect> : null}
    <ErrorNote error={query.error ?? action.error} />
  </div>;
}
