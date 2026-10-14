import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SdlcModeView } from "@xdev-hive/contracts";
import { SdlcProvider } from "@xdev-hive/sdlc-ui";
import { ModeEditor } from "@xdev-hive/sdlc-ui/mode-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { useId, useState } from "react";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useLang } from "@/lib/i18n.ts";
import { useWebSdlcEnv } from "@/lib/sdlc-env.tsx";
import { GateConfig } from "@/pages/knowledge/workflow-gate-config.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export function SdlcModesPage() {
  const { api } = useOrg();
  const lang = useLang();
  const env = useWebSdlcEnv();
  const client = useQueryClient();
  const field = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SdlcModeView | null>(null);
  const modes = useQuery(api.sdlc.modes.list.queryOptions({ input: {} }));
  const teams = useQuery(api.teams.list.queryOptions());
  const members = useQuery(api.orgMembers.list.queryOptions());
  const mode = modes.data?.find((m) => m.ref === selected) ?? modes.data?.[0];
  const remove = useMutation(
    api.sdlc.modes.remove.mutationOptions({
      onSuccess: () => {
        setRemoving(null);
        setSelected(null);
        void client.invalidateQueries({ queryKey: api.sdlc.modes.key() });
      },
    }),
  );
  return (
    <>
      <PageHeader
        title={lang === "vi" ? "Chế độ AI SDLC" : "AI SDLC modes"}
        description={
          lang === "vi"
            ? "Tạo bản sao từ preset, cấu hình giai đoạn, cổng và bước agent. Hạng mục đã tạo giữ bản chụp chế độ."
            : "Copy a preset and configure phases, gates and agent steps. Existing items retain their mode snapshot."
        }
      />
      <PageBody>
        {modes.isPending ? (
          <LoadingState />
        ) : modes.error ? (
          <LoadFailure error={modes.error} retry={() => void modes.refetch()} />
        ) : !mode ? (
          <p>{lang === "vi" ? "Chưa có chế độ." : "No modes yet."}</p>
        ) : (
          <div className="mx-auto grid min-w-0 max-w-4xl gap-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid min-w-0 flex-1 gap-1">
                <label htmlFor={field}>{lang === "vi" ? "Chế độ" : "Mode"}</label>
                <NativeSelect id={field} value={mode.ref} onChange={(e) => setSelected(e.target.value)}>
                  {modes.data?.map((m) => (
                    <option key={m.ref} value={m.ref}>
                      {m.definition.name} ·{" "}
                      {m.preset
                        ? "Preset"
                        : m.teamId
                          ? (teams.data?.find((t) => t.id === m.teamId)?.name ?? m.teamId)
                          : lang === "vi"
                            ? "Tổ chức"
                            : "Organization"}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {!mode.preset && env.can.manageModes && (
                <Button variant="outline" onClick={() => setRemoving(mode)}>
                  {lang === "vi" ? "Xoá chế độ" : "Remove mode"}
                </Button>
              )}
            </div>
            <SdlcProvider env={env}>
              <ModeEditor
                key={`${mode.ref}/${mode.version}`}
                mode={mode}
                teams={teams.data ?? []}
                onSaved={(saved) => {
                  client.setQueryData(
                    api.sdlc.modes.list.queryKey({ input: {} }),
                    (previous: SdlcModeView[] | undefined) => [
                      ...(previous ?? []).filter((m) => m.ref !== saved.ref),
                      saved,
                    ],
                  );
                  setSelected(saved.ref);
                }}
                renderGate={(props) => <GateConfig {...props} teams={teams.data ?? []} members={members.data ?? []} />}
              />
            </SdlcProvider>
          </div>
        )}
        <Dialog
          open={!!removing}
          onOpenChange={(open) => {
            if (!open && !remove.isPending) setRemoving(null);
          }}
        >
          {removing && (
            <DialogContent>
              <DialogTitle>
                {lang === "vi" ? "Xoá chế độ" : "Remove mode"} · {removing.definition.name}
              </DialogTitle>
              <DialogDescription>
                {lang === "vi"
                  ? `${removing.openItems} hạng mục đang mở giữ bản chụp hiện tại. Không thể tạo hạng mục mới bằng chế độ này.`
                  : `${removing.openItems} open items retain their snapshot. This mode will be unavailable for new items.`}
              </DialogDescription>
              {remove.error && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
              <DialogActions>
                <Button variant="outline" disabled={remove.isPending} onClick={() => setRemoving(null)}>
                  {lang === "vi" ? "Huỷ" : "Cancel"}
                </Button>
                <Button disabled={remove.isPending} onClick={() => remove.mutate({ id: removing.ref })}>
                  {lang === "vi" ? "Xác nhận xoá" : "Confirm removal"}
                </Button>
              </DialogActions>
            </DialogContent>
          )}
        </Dialog>
      </PageBody>
    </>
  );
}
