import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SDLC_MAX_PROJECTS, type SdlcItemDetail } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/table";
import { useId, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";

/**
 * Dự án của hạng mục (D19): cài đặt là bản chụp lúc thêm. Thêm/bỏ dự án tham gia cho chủ hoặc quản trị đội chủ trì; hub
 * từ chối bỏ dự án đã có task chạy.
 */
export function ProjectsPanel({ item }: { item: SdlcItemDetail }) {
  const { api, can, errorMessage } = useSdlcEnv();
  const t = useText().detail;
  const ids = useId();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState("");
  const editable = item.can.editProjects && item.status === "active";
  const projects = useQuery({ ...api.projects.list.queryOptions({ input: {} }), enabled: editable });
  const onSuccess = () => void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
  const add = useMutation(
    api.sdlc.items.projects.add.mutationOptions({
      onSuccess: () => {
        setAdding("");
        onSuccess();
      },
    }),
  );
  const remove = useMutation(api.sdlc.items.projects.remove.mutationOptions({ onSuccess }));
  const present = new Set(item.projectsDetail.map((p) => p.id));
  const candidates = (projects.data ?? []).filter(
    (p) => !present.has(p.id) && p.settings.sdlc?.enabled && can.write(p.teamId),
  );
  const full = item.projectsDetail.length >= SDLC_MAX_PROJECTS;
  const error = add.error ?? remove.error;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t.projLead}</p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.colProject}</TableHead>
              <TableHead>{t.colTeam}</TableHead>
              <TableHead>{t.colGate}</TableHead>
              <TableHead>{t.colSync}</TableHead>
              <TableHead>{t.colPar}</TableHead>
              <TableHead>{t.colWhere}</TableHead>
              <TableHead>{t.colAi}</TableHead>
              {editable && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {item.projectsDetail.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <span className="font-mono font-medium">{p.key}</span>
                  {p.role === "home" && (
                    <Pill tone="sel" small className="ml-2">
                      {t.mainMark}
                    </Pill>
                  )}
                </TableCell>
                <TableCell>{p.teamName}</TableCell>
                <TableCell>{t.blocking[p.settings.blocking ?? item.mode.blocking]}</TableCell>
                <TableCell>{t.repoSync[p.settings.repoSync]}</TableCell>
                <TableCell className="tabular-nums">{p.settings.maxParallel}</TableCell>
                <TableCell>
                  {t.runner[p.settings.runner]}
                  {p.settings.labels.length > 0 && (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">{p.settings.labels.join(", ")}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Pill tone={p.enabled ? "ok" : "bad"} small dot>
                    {p.enabled ? t.enabledYes : t.enabledNo}
                  </Pill>
                </TableCell>
                {editable && (
                  <TableCell>
                    {p.role === "participant" && (
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={remove.isPending}
                        aria-label={`${t.dropProj}: ${p.key}`}
                        onClick={() => remove.mutate({ id: item.id, projectId: p.id })}
                      >
                        {t.dropProj}
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}
      {editable && (
        <form
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding) add.mutate({ id: item.id, projectId: adding });
          }}
        >
          <h3 className="text-sm font-semibold">{t.addProj}</h3>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex w-56 flex-col gap-1 max-sm:w-full">
              <Label htmlFor={`${ids}-add`}>{t.pickProj}</Label>
              <NativeSelect
                id={`${ids}-add`}
                value={adding}
                disabled={full}
                onChange={(e) => setAdding(e.target.value)}
              >
                <NativeSelectOption value="">—</NativeSelectOption>
                {candidates.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.key}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" disabled={!adding || full || add.isPending}>
              {t.addProjBtn}
            </Button>
          </div>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            <li>{t.ruleMax(item.projectsDetail.length, SDLC_MAX_PROJECTS)}</li>
            <li>{t.rulePerm}</li>
            <li>{t.ruleDrop}</li>
          </ul>
        </form>
      )}
    </div>
  );
}
