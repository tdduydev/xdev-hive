// "Task mới" (⌘N): title, project and, on the desktop, an agent of this machine to start it right away.
import { useEffect, useMemo, useState } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote } from "../components/common.tsx";
import { useAction, useCan, useHive, useQuery } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { scopeProject } from "../lib/scope.ts";
import { nextTaskId } from "../lib/tasks.ts";
import { useToast } from "./toast.tsx";

export function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { client, scope, projects, bump } = useHive();
  const t = useT();
  const allow = useCan();
  const toast = useToast();
  const action = useAction();
  const writable = useMemo(() => projects.filter((p) => allow(p, "contribute")), [projects, allow]);
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [profile, setProfile] = useState("");

  const settings = useQuery(async () => (open && client.desktop ? client.desktop.settings() : null), [client, open]);
  const profiles = useQuery(async () => (open && client.desktop ? client.desktop.profiles() : []), [client, open]);
  const existing = useQuery(async () => (open && project ? client.call("tasks.list", { project }) : []), [client, open, project]);

  useEffect(() => {
    if (!open) return;
    const fromScope = scopeProject(scope);
    setTitle("");
    setProfile("");
    setIdTouched(false);
    setProject(fromScope && writable.includes(fromScope) ? fromScope : (writable[0] ?? ""));
    action.setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!idTouched && existing.data) setId(nextTaskId(existing.data));
  }, [existing.data, idTouched]);

  const onMachine = Boolean(settings.data?.projects.some((p) => p.name === project));
  const usable = (profiles.data ?? []).filter((p) => p.enabled);
  const ready = Boolean(title.trim() && project && id.trim()) && !action.busy;

  const submit = () =>
    void action.run(async () => {
      const task = await client.call("tasks.create", { id: id.trim(), project, title: title.trim(), dependsOn: [] });
      if (profile && client.desktop) await client.desktop.startRun({ project, taskId: task.id, profileId: profile });
      bump();
      onOpenChange(false);
      toast(profile ? t("newTask.createdAssigned", { id: task.id, profile }) : t("newTask.created", { id: task.id }));
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[72px] translate-y-0 gap-0 p-0 sm:max-w-[520px]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) submit();
          }}
        >
          <DialogHeader className="px-[18px] pt-4 pb-1">
            <DialogTitle className="text-[15px]/5">{t("newTask.title")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 px-[18px] pt-2.5 pb-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-task-title">{t("newTask.name")}</Label>
              <Input
                id="new-task-title"
                autoFocus
                className="h-[34px]"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("newTask.namePlaceholder")}
              />
            </div>
            <div className={client.desktop ? "grid grid-cols-[1fr_1fr_120px] gap-3" : "grid grid-cols-[1fr_120px] gap-3"}>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="new-task-project">{t("newTask.project")}</Label>
                <NativeSelect
                  id="new-task-project"
                  wrapperClassName="w-full"
                  className="h-[34px] font-mono"
                  value={project}
                  onChange={(e) => {
                    setProject(e.target.value);
                    setIdTouched(false);
                  }}
                >
                  {writable.length === 0 ? <NativeSelectOption value="">{t("newTask.projectPlaceholder")}</NativeSelectOption> : null}
                  {writable.map((p) => (
                    <NativeSelectOption key={p} value={p}>
                      {p}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              {client.desktop ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Label htmlFor="new-task-agent">{t("newTask.assign")}</Label>
                  <NativeSelect
                    id="new-task-agent"
                    wrapperClassName="w-full"
                    className="h-[34px] font-mono"
                    value={profile}
                    disabled={!onMachine}
                    onChange={(e) => setProfile(e.target.value)}
                  >
                    <NativeSelectOption value="">{t("newTask.unassigned")}</NativeSelectOption>
                    {usable.map((p) => (
                      <NativeSelectOption key={p.id} value={p.id}>
                        {p.id}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              <div className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor="new-task-id">{t("newTask.id")}</Label>
                <Input
                  id="new-task-id"
                  className="h-[34px] font-mono text-[13px]"
                  value={id}
                  onChange={(e) => {
                    setId(e.target.value);
                    setIdTouched(true);
                  }}
                />
              </div>
            </div>
            {client.desktop ? (
              <p className="type-caption font-normal text-fg-muted">{project && !onMachine ? t("newTask.notOnMachine") : t("newTask.assignHint")}</p>
            ) : null}
            <ErrorNote error={action.error} />
          </div>
          <DialogFooter className="border-t border-line-subtle px-[18px] py-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!ready}>
              {t("newTask.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
