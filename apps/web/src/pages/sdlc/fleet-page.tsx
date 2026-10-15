import { useQuery } from "@tanstack/react-query";
import { FleetTable, SdlcProvider } from "@xdev-hive/sdlc-ui";
import { Button } from "@xdev-hive/ui/button";
import { Dialog } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { useId, useState } from "react";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { useLang } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { useWebSdlcEnv } from "@/lib/sdlc-env.tsx";
import { RegistrationDialog } from "@/pages/machines-page.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export function SdlcFleetPage() {
  const { api } = useOrg();
  const lang = useLang();
  const can = usePermissions();
  const teamField = useId();
  const [teamId, setTeamId] = useState("");
  const [adding, setAdding] = useState(false);
  const teams = useQuery(api.teams.list.queryOptions());
  const fleet = useQuery({
    ...api.machines.sdlc.queryOptions({ input: teamId ? { teamId } : {} }),
    refetchInterval: 15_000,
  });
  const env = useWebSdlcEnv();
  return (
    <>
      <PageHeader
        title={lang === "vi" ? "Đội máy AI SDLC" : "AI SDLC fleet"}
        description={
          lang === "vi"
            ? "Máy có nhãn, run đang chạy và quota của gói agent."
            : "Labelled machines, active runs and agent account quota."
        }
      >
        {can("machines.register") && (
          <Button disabled={!teamId} onClick={() => setAdding(true)}>
            {lang === "vi" ? "Thêm máy" : "Add machine"}
          </Button>
        )}
      </PageHeader>
      <PageBody>
        <div className="mb-4 grid max-w-xs gap-1 text-sm">
          <label htmlFor={teamField}>{lang === "vi" ? "Đội" : "Team"}</label>
          <NativeSelect id={teamField} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">{lang === "vi" ? "Tất cả đội" : "All teams"}</option>
            {teams.data?.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        {teams.error && <LoadFailure error={teams.error} retry={() => void teams.refetch()} />}
        {fleet.isPending ? (
          <LoadingState />
        ) : fleet.error ? (
          <LoadFailure error={fleet.error} retry={() => void fleet.refetch()} />
        ) : (
          <SdlcProvider env={env}>
            <FleetTable machines={fleet.data} />
          </SdlcProvider>
        )}
        <Dialog open={adding} onOpenChange={setAdding}>
          {adding && teamId && (
            <RegistrationDialog key={teamId} teamId={teamId} sdlc onClose={() => setAdding(false)} />
          )}
        </Dialog>
      </PageBody>
    </>
  );
}
