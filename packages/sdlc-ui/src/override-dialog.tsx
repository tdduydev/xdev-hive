import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SdlcItemDetail } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";

const REASON_MIN = 10;

type Scope = "item" | "project" | "task";

export interface OverrideDialogProps {
  item: SdlcItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Ngoại lệ chặn run code (FR-016, `sdlc.override`): phạm vi task, một dự án trong hạng mục, hoặc cả hạng mục. Hạn để
 * trống là đến khi thu hồi; hub ghi audit.
 */
export function OverrideDialog({ item, open, onOpenChange }: OverrideDialogProps) {
  const { api, errorMessage } = useSdlcEnv();
  const t = useText().detail;
  const ids = useId();
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<Scope>("item");
  const [projectId, setProjectId] = useState(item.projectsDetail[0]?.id ?? "");
  const [taskId, setTaskId] = useState(item.tasks[0]?.taskId ?? "");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");

  const create = useMutation(
    api.sdlc.overrides.create.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
        setReason("");
        onOpenChange(false);
      },
    }),
  );
  const ok =
    reason.trim().length >= REASON_MIN && (scope !== "task" || !!taskId) && (scope !== "project" || !!projectId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.excTitle}</DialogTitle>
          <DialogDescription>{t.excLead}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ok) return;
            create.mutate({
              itemId: item.id,
              reason: reason.trim(),
              ...(scope === "project" ? { projectId } : {}),
              ...(scope === "task" ? { taskId } : {}),
              ...(until ? { expiresAt: new Date(until).toISOString() } : {}),
            });
          }}
        >
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{t.excScope}</legend>
            {(
              [
                ["item", t.scopeItem],
                ["project", t.scopeProject],
                ["task", t.scopeTask],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${ids}-scope`}
                  checked={scope === key}
                  disabled={key === "task" && !item.tasks.length}
                  onChange={() => setScope(key)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {scope === "project" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-project`}>{t.pickProj}</Label>
              <NativeSelect id={`${ids}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {item.projectsDetail.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.key}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {scope === "task" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-task`}>{t.tabs.tasks}</Label>
              <NativeSelect id={`${ids}-task`} value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                {item.tasks.map((task) => (
                  <NativeSelectOption key={task.taskId} value={task.taskId}>
                    {`${task.key} · ${task.title}`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-reason`}>{t.reason}</Label>
            <Textarea
              id={`${ids}-reason`}
              rows={3}
              value={reason}
              maxLength={2000}
              placeholder={t.excReasonHint}
              aria-describedby={`${ids}-reason-hint`}
              onChange={(e) => setReason(e.target.value)}
            />
            <p id={`${ids}-reason-hint`} className="text-xs text-muted-foreground">
              {t.reasonNeed(REASON_MIN)}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-until`}>{t.excUntil}</Label>
            <Input id={`${ids}-until`} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t.excUntilHelp}</p>
          </div>
          {create.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(create.error)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={!ok || create.isPending}>
              {t.excSubmit}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
