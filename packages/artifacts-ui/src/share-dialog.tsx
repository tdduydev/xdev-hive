import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ARTIFACT_MVP_SCOPES, type ArtifactScope, type ArtifactSummary } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { useId, useState } from "react";
import { useArtifactsEnv } from "./env.tsx";
import { useEditText } from "./text-edit.ts";

export interface ShareDialogProps {
  artifact: ArtifactSummary;
  /** Phiên bản đang xem; cũ hơn bản mới nhất thì hộp cảnh báo người được chia sẻ thấy bản mới nhất. */
  version: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Từ hẹp tới rộng: chia sẻ rộng hơn thì người mới thấy cả lịch sử, nên đòi tick xác nhận. */
const SCOPE_ORDER: readonly ArtifactScope[] = ["private", "project", "team", "org"];
const scopeRank = (scope: ArtifactScope) => SCOPE_ORDER.indexOf(scope);

/**
 * Đổi phạm vi (ArtifactShare.dc.html). Chia sẻ rộng hơn cho cả dự án, đội hay tổ chức cho họ thấy mọi phiên bản cũ, nên
 * phải tick xác nhận đã xem lại lịch sử. `team` và `org` chỉ hiện khi chính sách tổ chức bật. Link công khai là việc
 * khác, mở ở hộp riêng của chủ.
 */
export function ShareDialog({ artifact, version, open, onOpenChange }: ShareDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <ShareBody artifact={artifact} version={version} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Tách khỏi vỏ hộp để hook và lượt tải danh sách dự án chỉ chạy khi hộp mở, và mỗi lần mở bắt đầu từ trạng thái sạch. */
function ShareBody({
  artifact,
  version,
  onClose,
}: Pick<ShareDialogProps, "artifact" | "version"> & { onClose: () => void }) {
  const env = useArtifactsEnv();
  const t = useEditText();
  const queryClient = useQueryClient();
  const scopeName = useId();
  const projectId = useId();
  const teamId = useId();
  const [scope, setScope] = useState<ArtifactScope>(artifact.scope);
  const [project, setProject] = useState(artifact.project?.key ?? "");
  const [team, setTeam] = useState(artifact.teamId ?? "");
  const [ack, setAck] = useState(false);
  const [saved, setSaved] = useState(false);

  const projects = useQuery({
    ...env.api.projects.list.queryOptions({ input: {} }),
    enabled: !env.offline && scope === "project",
  });
  const teams = useQuery({ ...env.api.teams.list.queryOptions(), enabled: !env.offline && scope === "team" });
  // Chưa tải được chính sách thì chỉ đưa phạm vi MVP; hub vẫn chặn phạm vi đang tắt (`ARTIFACT_SCOPE_DISABLED`).
  const settings = useQuery({ ...env.api.artifacts.settings.queryOptions(), enabled: !env.offline });
  const setScopeMutation = useMutation(
    env.api.artifacts.setScope.mutationOptions({
      onSuccess: () => {
        setSaved(true);
        void queryClient.invalidateQueries({ queryKey: env.api.artifacts.key() });
      },
    }),
  );

  const list = projects.data ?? [];
  // Gợi ý dự án đã sinh ra artifact (không cấp quyền đọc), để chủ khỏi tìm lại.
  const suggested = list.find((p) => p.id === artifact.originProjectId)?.key ?? "";
  const projectKey = project || suggested;
  const projectName = artifact.project?.name ?? list.find((p) => p.key === projectKey)?.name ?? projectKey;
  const teamList = teams.data ?? [];
  const teamName = teamList.find((x) => x.id === team)?.name ?? team;
  const enabled = settings.data?.scopes ?? ARTIFACT_MVP_SCOPES;
  // Phạm vi hiện tại của artifact luôn có trong danh sách dù chính sách đã tắt nó sau đó.
  const offered = SCOPE_ORDER.filter((s) => enabled.includes(s) || s === artifact.scope);
  const widening = scopeRank(scope) > scopeRank(artifact.scope);
  const unchanged =
    scope === artifact.scope &&
    (scope === "project" ? projectKey === artifact.project?.key : scope !== "team" || team === artifact.teamId);
  const cannotSave =
    env.offline ||
    setScopeMutation.isPending ||
    unchanged ||
    (scope === "project" && !projectKey) ||
    (scope === "team" && !team) ||
    (widening && !ack);
  const older = version < artifact.latestVersion;

  const scopeLabel: Record<ArtifactScope, string> = {
    private: t.scopePrivate,
    project: t.scopeProject,
    team: t.scopeTeam,
    org: t.scopeOrg,
  };
  const scopeHelp: Record<ArtifactScope, string> = {
    private: t.scopePrivateHelp,
    project: t.scopeProjectHelp,
    team: t.scopeTeamHelp,
    org: t.scopeOrgHelp,
  };
  const choose = (next: ArtifactScope) => {
    setScope(next);
    setSaved(false);
    setAck(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t.shareTitle}</DialogTitle>
        <DialogDescription>
          {artifact.title} · v{version}
        </DialogDescription>
      </DialogHeader>

      {env.offline && (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {t.offline}
        </p>
      )}
      {older && (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {t.olderVersion(version, artifact.latestVersion)}
        </p>
      )}

      <fieldset className="flex flex-col gap-3 border-0 p-0">
        <legend className="mb-1 font-medium">{t.shareScope}</legend>
        {offered.map((value) => (
          <label key={value} className="flex items-start gap-2">
            <input
              type="radio"
              name={scopeName}
              value={value}
              checked={scope === value}
              disabled={env.offline}
              onChange={() => choose(value)}
              className="mt-1"
            />
            <span>
              <strong className="block font-medium">{scopeLabel[value]}</strong>
              <span className="text-muted-foreground">{scopeHelp[value]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {scope === "project" && (
        <div className="flex flex-col gap-3">
          <label htmlFor={projectId} className="flex flex-col gap-1">
            {t.projectLabel}
            <NativeSelect
              id={projectId}
              value={projectKey}
              disabled={env.offline || projects.isPending}
              onChange={(e) => {
                setProject(e.target.value);
                setSaved(false);
              }}
            >
              <NativeSelectOption value="">
                {projects.isPending ? t.projectsLoading : t.projectChoose}
              </NativeSelectOption>
              {/* Dự án hiện tại của artifact luôn có trong danh sách dù danh sách chưa tải xong hay người xem không thấy nó. */}
              {artifact.project && !list.some((p) => p.key === artifact.project?.key) && (
                <NativeSelectOption value={artifact.project.key}>{artifact.project.name}</NativeSelectOption>
              )}
              {list.map((p) => (
                <NativeSelectOption key={p.id} value={p.key}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {projects.isError && (
            <p role="alert" className="text-sm text-destructive">
              {env.errorMessage(projects.error)}
            </p>
          )}
        </div>
      )}

      {scope === "team" && (
        <div className="flex flex-col gap-3">
          <label htmlFor={teamId} className="flex flex-col gap-1">
            {t.teamLabel}
            <NativeSelect
              id={teamId}
              value={team}
              disabled={env.offline || teams.isPending}
              onChange={(e) => {
                setTeam(e.target.value);
                setSaved(false);
              }}
            >
              <NativeSelectOption value="">{teams.isPending ? t.teamsLoading : t.teamChoose}</NativeSelectOption>
              {teamList.map((x) => (
                <NativeSelectOption key={x.id} value={x.id}>
                  {x.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          {teams.isError && (
            <p role="alert" className="text-sm text-destructive">
              {env.errorMessage(teams.error)}
            </p>
          )}
        </div>
      )}

      {widening && (
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-warning">
          <strong>
            {scope === "project"
              ? t.historyWarning(projectName)
              : scope === "team"
                ? t.historyWarningTeam(teamName)
                : t.historyWarningOrg}
          </strong>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {t.ack}
          </label>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t.publicSeparate}</p>

      {saved && (
        <p role="status" aria-live="polite" className="rounded-md bg-success-soft px-3 py-2 text-success">
          {t.shared}
        </p>
      )}
      {setScopeMutation.error != null && (
        <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-destructive">
          {env.errorMessage(setScopeMutation.error)}
        </p>
      )}

      <DialogActions>
        <Button variant="outline" onClick={onClose}>
          {t.close}
        </Button>
        <Button
          disabled={cannotSave}
          onClick={() =>
            setScopeMutation.mutate(
              scope === "project"
                ? { id: artifact.id, scope, projectKey }
                : scope === "team"
                  ? { id: artifact.id, scope, teamId: team }
                  : { id: artifact.id, scope },
            )
          }
        >
          {t.shareSave}
        </Button>
      </DialogActions>
    </>
  );
}
