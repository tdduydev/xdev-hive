import { useState } from "react";
import type { RunTimeoutSettings } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { ErrorNote } from "#ui/components/common.tsx";
import { useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

export function RunTimeoutsCard() {
  const { client, bump } = useHive();
  const t = useT();
  const query = useQuery(() => client.call("runs.timeoutSettings", {}), [client]);
  const [draft, setDraft] = useState<RunTimeoutSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const value = draft ?? query.data;
  return <Card>
    <CardHeader><CardTitle>{t("runTimeout.title")}</CardTitle><CardDescription>{t("runTimeout.hint")}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <ErrorNote error={query.error ?? action.error} />
      {value ? <form className="space-y-4" onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => { setDraft(await client.call("runs.setTimeoutSettings", value)); setSaved(true); bump(); });
      }}>
        <label className="flex flex-col gap-1.5 text-sm">{t("runTimeout.max")}
          <Input data-run-timeout-max className="max-md:h-11 max-md:text-base" type="number" required min={1} max={720} step={1} value={value.maxMinutes} onChange={(e) => { setSaved(false); setDraft({ ...value, maxMinutes: Number(e.target.value) }); }} />
        </label>
        <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">{t("runTimeout.defaults")}</legend>
          {(["integration", "land"] as const).map((kind) => <label key={kind} className="flex flex-col gap-1.5 text-sm">{t(`runTimeout.${kind}`)}
            <Input data-run-timeout-kind={kind} className="max-md:h-11 max-md:text-base" type="number" min={1} max={720} step={1} placeholder={t("runTimeout.profile")} value={value.defaults[kind] ?? ""} onChange={(e) => { setSaved(false); setDraft({ ...value, defaults: { ...value.defaults, [kind]: e.target.value ? Number(e.target.value) : null } }); }} />
          </label>)}
          <p className="text-sm text-muted-foreground">{t("runTimeout.otherTasks")}: {t("runTimeout.profile")}</p>
        </fieldset>
        <Button type="submit" className="max-md:min-h-11" disabled={action.busy}>{t("runTimeout.save")}</Button>
        {saved ? <p role="status" className="text-sm text-success">{t("runTimeout.saved")}</p> : null}
      </form> : null}
    </CardContent>
  </Card>;
}
