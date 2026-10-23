import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactListQuery } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { useState } from "react";
import { ARTIFACT_TYPE_ICON } from "./card.tsx";
import { useArtifactsEnv, useText } from "./env.tsx";

/** Nơi artifact được gắn vào: task, run, hạng mục AI SDLC, tài liệu; dự án thì liệt kê theo phạm vi, không gắn tay. */
export type LinkedTarget =
  | { kind: "task" | "run" | "sdlc_item" | "doc"; id: string }
  | { kind: "project"; projectKey: string };

const filterOf = (target: LinkedTarget): ArtifactListQuery => {
  switch (target.kind) {
    case "task":
      return { taskId: target.id };
    case "run":
      return { runId: target.id };
    case "sdlc_item":
      return { sdlcItemId: target.id };
    case "doc":
      return { docId: target.id };
    case "project":
      return { projectKey: target.projectKey };
  }
};

export interface LinkedArtifactsProps {
  target: LinkedTarget;
  /** Người xem sửa được đích: hiện "Gắn artifact" và "Bỏ gắn". Hub vẫn kiểm lại quyền ở đích (FR-100). */
  canLink?: boolean | undefined;
}

/**
 * Mục Artifact của trang task, run, hạng mục, tài liệu và dự án (FR-101): chỉ liệt kê artifact người xem đọc được, vì
 * hub lọc theo quyền đọc ở `artifacts.list`. Gắn chỉ là siêu dữ liệu, không đổi prompt hay nội dung của đích.
 */
export function LinkedArtifacts({ target, canLink = false }: LinkedArtifactsProps) {
  const env = useArtifactsEnv();
  const t = useText();
  const queryClient = useQueryClient();
  const [pick, setPick] = useState("");
  const [error, setError] = useState("");
  const manual = target.kind !== "project" && canLink && !env.offline;

  const linked = useQuery({
    ...env.api.artifacts.list.queryOptions({ input: { ...filterOf(target), limit: 50 } }),
    enabled: !env.offline,
  });
  const mine = useQuery({
    ...env.api.artifacts.list.queryOptions({ input: { mine: true, limit: 50 } }),
    enabled: manual,
  });
  const items = linked.data?.items ?? [];
  const linkedIds = new Set(items.map((item) => item.id));
  const candidates = (mine.data?.items ?? []).filter((item) => !linkedIds.has(item.id));

  const refresh = () => queryClient.invalidateQueries({ queryKey: env.api.artifacts.list.key() });
  const attach = useMutation({
    mutationFn: (id: string) => {
      if (target.kind === "project") throw new Error("Dự án không gắn tay.");
      return env.api.artifacts.links.add.call({ id, targetKind: target.kind, targetId: target.id });
    },
    onSuccess: async () => {
      setPick("");
      setError("");
      await refresh();
    },
    onError: (e) => setError(env.errorMessage(e)),
  });
  const detach = useMutation({
    mutationFn: (id: string) => {
      if (target.kind === "project") throw new Error("Dự án không gắn tay.");
      return env.api.artifacts.links.remove.call({ id, targetKind: target.kind, targetId: target.id });
    },
    onSuccess: async () => {
      setError("");
      await refresh();
    },
    onError: (e) => setError(env.errorMessage(e)),
  });

  return (
    <section aria-label={t.linkedTitle} className="flex flex-col gap-3">
      <h2 className="font-heading text-base font-semibold">{t.linkedTitle}</h2>
      {linked.isPending && !env.offline && <p className="text-sm text-muted-foreground">{t.loading}</p>}
      {linked.isError && (
        <p role="alert" className="text-sm text-destructive">
          {env.errorMessage(linked.error)}
        </p>
      )}
      {linked.isSuccess && items.length === 0 && <p className="text-sm text-muted-foreground">{t.linkedEmpty}</p>}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const Icon = ARTIFACT_TYPE_ICON[item.type];
            return (
              <li key={item.id} className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-3">
                <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  {env.link({
                    to: { kind: "artifact", id: item.id },
                    className: "block truncate font-medium text-primary underline-offset-4 hover:underline",
                    children: item.title,
                  })}
                  <p className="font-mono text-xs text-muted-foreground">
                    {item.type} · {t.version(item.latestVersion)}
                  </p>
                </div>
                <Pill>{t.scope[item.scope]}</Pill>
                {manual && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t.linkedUnlinkLabel(item.title)}
                    disabled={detach.isPending}
                    onClick={() => detach.mutate(item.id)}
                  >
                    {t.linkedUnlink}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {manual && (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label={t.linkedPick}
            value={pick}
            onChange={(event) => setPick(event.target.value)}
            disabled={candidates.length === 0}
          >
            <NativeSelectOption value="">{candidates.length === 0 ? t.linkedNone : t.linkedPick}</NativeSelectOption>
            {candidates.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button size="sm" disabled={!pick || attach.isPending} onClick={() => attach.mutate(pick)}>
            {t.linkedAttach}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
