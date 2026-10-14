import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ARTIFACT_LIMITS, type ArtifactAccess, type ArtifactVersionMeta } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { useId, useState } from "react";
import { VersionCompare } from "./compare.tsx";
import { useArtifactsEnv } from "./env.tsx";
import { useEditText } from "./text-edit.ts";

export interface VersionHistoryProps {
  artifactId: string;
  /** Phiên bản đang xem. */
  current: number;
  access: ArtifactAccess;
  onOpen: (version: number) => void;
}

/** Tác giả để hiện: người, hoặc run của agent (id rút gọn vì tên run không có trong danh sách phiên bản). */
function authorOf(version: ArtifactVersionMeta): string {
  if (version.authorUser) return version.authorUser.name;
  return version.authorRunId ? `run ${version.authorRunId.slice(0, 8)}` : "";
}

type Pending = { kind: "rename"; version: number; name: string } | { kind: "restore"; version: number } | null;

/** Lịch sử phiên bản: danh sách, so sánh, đặt tên, khôi phục (ArtifactVersions.dc.html). Phiên bản đã lưu không sửa được. */
export function VersionHistory({ artifactId, current, access, onOpen }: VersionHistoryProps) {
  const env = useArtifactsEnv();
  const t = useEditText();
  const queryClient = useQueryClient();
  const fromId = useId();
  const toId = useId();
  const renameId = useId();
  const [pending, setPending] = useState<Pending>(null);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const list = useQuery({
    ...env.api.artifacts.versions.list.queryOptions({ input: { id: artifactId } }),
    enabled: !env.offline,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: env.api.artifacts.key() });
  const rename = useMutation(
    env.api.artifacts.versions.rename.mutationOptions({
      onSuccess: () => {
        setPending(null);
        setStatus(t.renamed);
        void refresh();
      },
    }),
  );
  const restore = useMutation(
    env.api.artifacts.versions.restore.mutationOptions({
      onSuccess: (result) => {
        setPending(null);
        setStatus(t.restored(result.version.version));
        void refresh();
        onOpen(result.version.version);
      },
    }),
  );

  const versions = list.data ?? [];
  const latest = versions[0]?.version ?? current;
  // Mặc định so bản mới nhất với bản liền trước: câu hỏi thường gặp nhất là "lần lưu cuối đổi gì".
  const toVersion = to ?? latest;
  const fromVersion = from ?? Math.max(1, latest - 1);
  const offline = env.offline;
  const writable = access.write && !offline;
  const error = rename.error ?? restore.error;

  if (offline)
    return (
      <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        {t.offline}
      </p>
    );
  if (list.isError)
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 rounded-md bg-destructive-soft p-3 text-sm text-destructive"
      >
        <p>{t.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
          {t.retry}
        </Button>
      </div>
    );
  if (list.isPending)
    return (
      <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
        …
      </p>
    );
  if (versions.length === 0) return <p className="text-sm text-muted-foreground">{t.versionsEmpty}</p>;

  const options = versions.map((v) => (
    <NativeSelectOption key={v.version} value={String(v.version)}>
      {`v${v.version}${v.name ? ` · ${v.name}` : ""}`}
    </NativeSelectOption>
  ));
  const date = new Intl.DateTimeFormat(env.lang === "en" ? "en-GB" : "vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t.immutable}</p>

      <section aria-label={t.compare} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label htmlFor={fromId} className="flex items-center gap-2">
            {t.compareFrom}
            <NativeSelect
              id={fromId}
              size="sm"
              className="w-auto"
              value={String(fromVersion)}
              onChange={(e) => setFrom(Number(e.target.value))}
            >
              {options}
            </NativeSelect>
          </label>
          <label htmlFor={toId} className="flex items-center gap-2">
            {t.compareTo}
            <NativeSelect
              id={toId}
              size="sm"
              className="w-auto"
              value={String(toVersion)}
              onChange={(e) => setTo(Number(e.target.value))}
            >
              {options}
            </NativeSelect>
          </label>
        </div>
        <VersionCompare artifactId={artifactId} left={fromVersion} right={toVersion} />
      </section>

      <ol className="flex flex-col gap-2">
        {versions.map((v) => {
          const isCurrent = v.version === current;
          const label = v.name ? `v${v.version} · ${v.name}` : `v${v.version}`;
          return (
            <li key={v.version} className="flex flex-col gap-1 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="font-mono">{label}</strong>
                {v.version === latest && <Pill tone="sel">{t.latest}</Pill>}
                {isCurrent && <Pill>{t.current}</Pill>}
                <Pill>{t.originLabel[v.origin] ?? v.origin}</Pill>
                {v.hasCompileError && <Pill tone="bad">{t.compileError}</Pill>}
              </div>
              <p className="text-xs text-muted-foreground">
                {authorOf(v)} · <time dateTime={v.createdAt}>{date.format(new Date(v.createdAt))}</time> ·{" "}
                {Math.max(1, Math.round(v.sizeBytes / 1024))} KiB
                {v.restoredFrom !== null && ` · ${t.restoredFrom(v.restoredFrom)}`}
              </p>
              {v.message && <p>{v.message}</p>}
              {v.tombstonedAt && <p className="text-xs text-muted-foreground">{t.tombstoned}</p>}

              {pending?.kind === "rename" && pending.version === v.version ? (
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    rename.mutate({ id: artifactId, version: v.version, name: pending.name.trim() || null });
                  }}
                >
                  <label htmlFor={renameId} className="flex flex-col gap-1 text-xs">
                    {t.renameLabel}
                    <Input
                      id={renameId}
                      value={pending.name}
                      maxLength={ARTIFACT_LIMITS.versionNameChars}
                      autoComplete="off"
                      onChange={(e) => setPending({ ...pending, name: e.target.value })}
                    />
                  </label>
                  <Button type="submit" size="sm" disabled={rename.isPending}>
                    {t.renameSave}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setPending(null)}>
                    {t.cancel}
                  </Button>
                </form>
              ) : pending?.kind === "restore" && pending.version === v.version ? (
                <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-warning">
                  <strong>{t.restoreTitle(v.version)}</strong>
                  <p>{t.restoreHelp(latest + 1)}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPending(null)}>
                      {t.cancel}
                    </Button>
                    <Button
                      size="sm"
                      disabled={restore.isPending}
                      onClick={() => restore.mutate({ id: artifactId, version: v.version, baseVersion: latest })}
                    >
                      {t.restoreConfirm}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {!isCurrent && (
                    <Button variant="outline" size="sm" onClick={() => onOpen(v.version)}>
                      {t.open}
                    </Button>
                  )}
                  {access.write && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!writable}
                      onClick={() => setPending({ kind: "rename", version: v.version, name: v.name ?? "" })}
                    >
                      {t.rename}
                    </Button>
                  )}
                  {access.write && v.version !== latest && v.tombstonedAt === null && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!writable}
                      onClick={() => setPending({ kind: "restore", version: v.version })}
                    >
                      {t.restore}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {status && (
        <p role="status" aria-live="polite" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {status}
        </p>
      )}
      {error != null && (
        <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {env.errorMessage(error)}
        </p>
      )}
    </div>
  );
}
