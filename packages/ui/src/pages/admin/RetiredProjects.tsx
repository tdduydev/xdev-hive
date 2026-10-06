// Cho một project key nghỉ (roadmap 38g): a key whose work is over leaves the scope picker and every project list,
// but nothing of it is deleted — the pages, tasks and runs stay, and Mở lại puts the key back.
import { useState } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Badge, Empty, ErrorNote } from "#ui/components/common.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

export function RetiredProjectsCard() {
  const { client, bump } = useHive();
  const t = useT();
  const known = useProjects();
  const retired = useQuery(() => client.call("projects.retired", {}), [client]);
  const [picked, setPicked] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  // The picker already leaves out keys that rest with nothing left on them; the rest are still in `known`.
  const resting = new Set((retired.data ?? []).map((r) => r.project));
  const choices = known.filter((p) => !resting.has(p));

  const after = () => {
    setConfirming(false);
    setNote("");
    retired.reload();
    bump();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("retire.title")}</CardTitle>
        <CardDescription>{t("retire.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1.5 text-sm">
            {t("retire.project")}
            <NativeSelect
              className="font-mono"
              aria-label={t("retire.project")}
              data-retire-project
              value={picked}
              onChange={(e) => (setPicked(e.target.value), setConfirming(false))}
            >
              <NativeSelectOption value="">{t("retire.pick")}</NativeSelectOption>
              {choices.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label className="flex min-w-[220px] flex-1 flex-col gap-1.5 text-sm">
            {t("retire.note")}
            <Input value={note} placeholder={t("retire.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
          </label>
          {confirming ? (
            <Button
              variant="destructive"
              data-retire-confirm
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await client.call("projects.retire", { project: picked, note: note.trim() || undefined });
                  setPicked("");
                  after();
                })
              }
            >
              {t("retire.confirm")}
            </Button>
          ) : (
            <Button variant="outline" disabled={!picked} data-retire-start onClick={() => setConfirming(true)}>
              {t("retire.action")}
            </Button>
          )}
        </div>
        <ErrorNote error={action.error ?? retired.error} />
        {retired.data?.length ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" data-retired-list>
            {retired.data.map((r) => (
              <li key={r.project} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line-default px-3 py-2">
                <span className="font-mono text-sm font-medium">{r.project}</span>
                {r.hidden ? (
                  <Badge tone="neutral">{t("retire.hidden")}</Badge>
                ) : (
                  <Badge tone="warn">{t("retire.left", { machines: r.left.machines, docs: r.left.docs, tasks: r.left.openTasks })}</Badge>
                )}
                <span className="text-xs text-muted-foreground">{t("retire.by", { time: formatTime(r.at), who: r.by })}</span>
                {r.note ? <span className="text-xs text-muted-foreground">· {r.note}</span> : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  data-resume={r.project}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await client.call("projects.resume", { project: r.project });
                      after();
                    })
                  }
                >
                  {t("retire.resume")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t("retire.none")}</Empty>
        )}
      </CardContent>
    </Card>
  );
}
