import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SdlcArtifactSync, SdlcSyncState } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { useSdlcEnv, useText } from "./env.tsx";
import { formatWhen, type Tone } from "./format.ts";

const syncTone: Record<SdlcSyncState, Tone> = {
  none: "neutral",
  pending: "warn",
  synced: "ok",
  failed: "bad",
  drifted: "warn",
  deleted: "bad",
};

export interface SyncStatusProps {
  itemId: string;
  syncs: SdlcArtifactSync[];
  /** Thử lại và ghi đè repo là việc của quản trị dự án; hub kiểm lại quyền. */
  canManage: boolean;
}

/**
 * Trạng thái đồng bộ của một tài liệu theo từng repo (Q1: mỗi repo một PR). Lỗi ở một repo không chặn repo khác nên
 * mỗi dòng có nút riêng.
 */
export function SyncStatus({ itemId, syncs, canManage }: SyncStatusProps) {
  const { api, lang, errorMessage } = useSdlcEnv();
  const t = useText().detail;
  const queryClient = useQueryClient();
  const sync = useMutation(
    api.sdlc.sync.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: api.sdlc.key() }),
    }),
  );
  if (!syncs.length) return <p className="text-xs text-muted-foreground">{t.syncAfter}</p>;
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label={t.syncByRepo} className="flex flex-col gap-1">
        {syncs.map((s) => (
          <li
            key={`${s.projectId}-${s.kind}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/50 px-2 py-1 text-xs"
          >
            <span className="font-mono font-medium">{s.projectKey}</span>
            <span className="text-muted-foreground">{s.kind === "copy" ? t.copy : t.source}</span>
            <span className="min-w-0 truncate font-mono text-muted-foreground" title={s.repoPath}>
              {s.repoPath}
            </span>
            <Pill tone={syncTone[s.state]} small dot>
              {t.syncState[s.state]}
            </Pill>
            {s.syncedVersion !== null && <span className="text-muted-foreground">v{s.syncedVersion}</span>}
            {s.syncedAt && <span className="text-muted-foreground">{formatWhen(s.syncedAt, lang)}</span>}
            {s.prUrl && (
              <a href={s.prUrl} target="_blank" rel="noreferrer" className="underline">
                {t.openPr}
              </a>
            )}
            {s.error && <span className="basis-full text-destructive">{s.error}</span>}
            {canManage && (s.state === "failed" || s.state === "pending") && (
              <Button
                variant="outline"
                size="xs"
                disabled={sync.isPending}
                onClick={() => sync.mutate({ id: itemId, projectId: s.projectId, action: "retry" })}
              >
                {t.retrySync}
              </Button>
            )}
            {canManage && (s.state === "drifted" || s.state === "deleted") && (
              <Button
                variant="outline"
                size="xs"
                title={t.overwriteHint}
                disabled={sync.isPending}
                onClick={() => sync.mutate({ id: itemId, projectId: s.projectId, action: "overwrite-repo" })}
              >
                {t.overwrite}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {sync.isError && <p className="text-xs text-destructive">{errorMessage(sync.error)}</p>}
    </div>
  );
}
