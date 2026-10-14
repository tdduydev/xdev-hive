import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactScope, ArtifactSummary } from "@xdev-hive/contracts";
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

/** Phạm vi MVP (D2): `team` và `org` chưa có giao diện nên chỉ hai giá trị này chọn được. */
type ShareScope = Extract<ArtifactScope, "private" | "project">;

/**
 * Đổi phạm vi `private`/`project` (ArtifactShare.dc.html). Chia sẻ cho dự án cho cả đội thấy mọi phiên bản cũ, nên phải
 * tick xác nhận đã xem lại lịch sử. Link công khai là việc khác, mở ở hộp riêng của chủ.
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
  const [scope, setScope] = useState<ShareScope>(artifact.scope === "project" ? "project" : "private");
  const [project, setProject] = useState(artifact.project?.key ?? "");
  const [ack, setAck] = useState(false);
  const [saved, setSaved] = useState(false);

  const projects = useQuery({
    ...env.api.projects.list.queryOptions({ input: {} }),
    enabled: !env.offline && scope === "project",
  });
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
  const widening = scope === "project" && artifact.scope !== "project";
  const unchanged = scope === artifact.scope && (scope === "private" || projectKey === artifact.project?.key);
  const cannotSave =
    env.offline ||
    setScopeMutation.isPending ||
    unchanged ||
    (scope === "project" && !projectKey) ||
    (widening && !ack);
  const older = version < artifact.latestVersion;

  const choose = (next: ShareScope) => {
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
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name={scopeName}
            value="private"
            checked={scope === "private"}
            disabled={env.offline}
            onChange={() => choose("private")}
            className="mt-1"
          />
          <span>
            <strong className="block font-medium">{t.scopePrivate}</strong>
            <span className="text-muted-foreground">{t.scopePrivateHelp}</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name={scopeName}
            value="project"
            checked={scope === "project"}
            disabled={env.offline}
            onChange={() => choose("project")}
            className="mt-1"
          />
          <span>
            <strong className="block font-medium">{t.scopeProject}</strong>
            <span className="text-muted-foreground">{t.scopeProjectHelp}</span>
          </span>
        </label>
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
          {widening && (
            <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-warning">
              <strong>{t.historyWarning(projectName)}</strong>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                {t.ack}
              </label>
            </div>
          )}
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
              scope === "project" ? { id: artifact.id, scope, projectKey } : { id: artifact.id, scope },
            )
          }
        >
          {t.shareSave}
        </Button>
      </DialogActions>
    </>
  );
}
