import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArtifactDetail, ArtifactPageError } from "@xdev-hive/contracts";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { cn } from "cn";
import {
  ArrowLeftIcon,
  CopyIcon,
  DownloadIcon,
  ExpandIcon,
  FileCodeIcon,
  FileTextIcon,
  GlobeIcon,
  PencilIcon,
  Share2Icon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ARTIFACT_TYPE_ICON } from "./card.tsx";
import { ConvertDialog } from "./convert-dialog.tsx";
import { useConvertText } from "./convert-text.ts";
import { ArtifactEditor } from "./editor.tsx";
import { type ArtifactRef, type CachedArtifact, useArtifactsEnv, useText } from "./env.tsx";
import { artifactFileName, downloadText, sourceLanguage } from "./files.ts";
import { ShareDialog } from "./share-dialog.tsx";
import { CodeViewer } from "./viewer/code.tsx";
import { ArtifactViewer } from "./viewer/index.tsx";

/** Phiên bản đang mở trong khung. */
export interface ArtifactSelection {
  id: string;
  version: number;
}

const keyOf = (ref: ArtifactSelection) => `${ref.id}@${ref.version}`;

/** Mỗi artifact một tab theo thứ tự xuất hiện trong chat, mang bản mới nhất mà chat biết. */
export function panelTabs(items: readonly ArtifactRef[]): ArtifactRef[] {
  const byId = new Map<string, ArtifactRef>();
  for (const item of items) {
    const prev = byId.get(item.id);
    if (!prev || item.version >= prev.version) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "NOT_FOUND";
}

export interface ArtifactPanelProps {
  /** Artifact của cuộc trò chuyện theo thứ tự thẻ trong chat (cũ trước); thẻ sau của cùng artifact là bản mới hơn. */
  items: readonly ArtifactRef[];
  value: ArtifactSelection | null;
  onValueChange: (value: ArtifactSelection) => void;
  /** "Đóng khung" (màn rộng). */
  onClose?: (() => void) | undefined;
  /** "Về cuộc trò chuyện" (màn hẹp, khung phủ toàn màn). */
  onBack?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * Khung bên cạnh của Leader (FR-041, ArtifactPanel.dc.html). Thẻ mới trong chat tự mở ở đây, trừ khi người xem đang sửa:
 * khi đó tab chỉ có chấm báo để không mất chỗ đang sửa (US1-2).
 */
export function ArtifactPanel({ items, value, onValueChange, onClose, onBack, className }: ArtifactPanelProps) {
  const env = useArtifactsEnv();
  const t = useText();
  const [editing, setEditing] = useState(false);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const tabs = panelTabs(items);

  const seen = useRef<Set<string> | null>(null);
  const live = useRef({ editing, value, onValueChange });
  live.current = { editing, value, onValueChange };
  const itemsKey = items.map(keyOf).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `itemsKey` đại diện cho `items` (mảng mới mỗi lần vẽ).
  useEffect(() => {
    const { editing, value, onValueChange } = live.current;
    if (!seen.current) {
      // Thẻ đã có lúc mở khung không phải "mới": chỉ mở bản cuối nếu chưa chọn gì.
      seen.current = new Set(items.map(keyOf));
      const last = items.at(-1);
      if (!value && last) onValueChange({ id: last.id, version: last.version });
      return;
    }
    const known = seen.current;
    const fresh = items.filter((item) => !known.has(keyOf(item)));
    for (const item of fresh) known.add(keyOf(item));
    const newest = fresh.at(-1);
    if (!newest) return;
    if (!editing) {
      onValueChange({ id: newest.id, version: newest.version });
      return;
    }
    // Bản mới của chính artifact đang sửa đã có thông báo riêng trong vùng sửa.
    const others = fresh.filter((item) => item.id !== value?.id).map((item) => item.id);
    if (others.length) setUnread((set) => new Set([...set, ...others]));
  }, [itemsKey]);

  const select = (ref: ArtifactSelection) => {
    setUnread((set) => {
      if (!set.has(ref.id)) return set;
      const next = new Set(set);
      next.delete(ref.id);
      return next;
    });
    onValueChange(ref);
  };

  return (
    <section
      aria-label={t.panel}
      className={cn("flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto bg-card p-4", className)}
    >
      <header className="flex flex-wrap items-center gap-2">
        {onBack && (
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeftIcon aria-hidden />
            {t.backChat}
          </Button>
        )}
        <h2 className="flex-1 font-heading text-base font-semibold">{t.panel}</h2>
        {env.link({
          to: { kind: "library" },
          className: "text-sm text-primary underline-offset-4 hover:underline",
          children: t.library,
        })}
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label={t.close} title={t.close} onClick={onClose}>
            <XIcon aria-hidden />
          </Button>
        )}
      </header>

      {tabs.length > 0 && (
        <nav aria-label={t.tabs} className="flex flex-wrap gap-2">
          {tabs.map((tab) => {
            const Icon = ARTIFACT_TYPE_ICON[tab.type];
            const selected = tab.id === value?.id;
            return (
              <Button
                key={tab.id}
                variant="outline"
                size="sm"
                aria-pressed={selected}
                // Đổi tab khi đang sửa sẽ mất chữ đang soạn; sửa xong hoặc huỷ rồi mới chuyển.
                disabled={editing && !selected}
                className={cn(selected && "border-primary bg-accent text-accent-foreground")}
                onClick={() => select({ id: tab.id, version: tab.version })}
              >
                <Icon aria-hidden />
                <span className="max-w-40 truncate">{tab.title}</span>
                <span className="font-mono text-xs">{t.version(tab.version)}</span>
                {unread.has(tab.id) && (
                  <span role="img" aria-label={t.newArtifact} className="size-2 rounded-full bg-primary" />
                )}
              </Button>
            );
          })}
        </nav>
      )}

      {env.offline && (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          {t.offline}
        </p>
      )}

      {value ? (
        <PanelBody
          key={keyOf(value)}
          value={value}
          chatLatest={tabs.find((tab) => tab.id === value.id)?.version ?? value.version}
          editing={editing}
          setEditing={setEditing}
          onValueChange={select}
        />
      ) : (
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <h3 className="font-heading text-base font-semibold">{t.empty}</h3>
          <p className="text-sm text-muted-foreground">{t.emptyHelp}</p>
        </div>
      )}
    </section>
  );
}

/** Bản đã đệm của app khi offline; web không có bộ đệm nên offline là lỗi tải. */
function useSelectedArtifact(value: ArtifactSelection) {
  const env = useArtifactsEnv();
  const online = useQuery({
    ...env.api.artifacts.get.queryOptions({ input: { id: value.id, version: value.version } }),
    enabled: !env.offline,
  });
  const cache = env.offlineCache;
  const cached = useQuery({
    queryKey: ["artifacts-offline", value.id, value.version],
    queryFn: (): Promise<CachedArtifact | null> => cache?.get(value.id, value.version) ?? Promise.resolve(null),
    enabled: env.offline && !!cache,
  });
  useEffect(() => {
    if (online.data) cache?.put(online.data);
  }, [online.data, cache]);
  return env.offline ? { kind: "offline" as const, query: cached } : { kind: "online" as const, query: online };
}

function PanelBody({
  value,
  chatLatest,
  editing,
  setEditing,
  onValueChange,
}: {
  value: ArtifactSelection;
  chatLatest: number;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  onValueChange: (value: ArtifactSelection) => void;
}) {
  const t = useText();
  const selected = useSelectedArtifact(value);
  const { query } = selected;

  if (query.isPending && query.fetchStatus !== "idle")
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <span role="status">{t.loading}</span>
        <div className="h-4 w-4/5 rounded-md bg-muted" />
        <div className="h-4 w-1/2 rounded-md bg-muted" />
        <div className="h-60 rounded-md bg-muted" />
      </div>
    );
  if (selected.kind === "offline" && !selected.query.data)
    return (
      <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        {t.notCached}
      </p>
    );
  if (isNotFound(query.error) || query.data?.artifact.deletedAt)
    return (
      <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
        {t.deleted}
      </p>
    );
  if (!query.data)
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 rounded-md bg-destructive-soft p-3 text-sm text-destructive"
      >
        <p>{t.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t.retry}
        </Button>
      </div>
    );
  return (
    <ArtifactView
      detail={query.data}
      cachedAt={selected.kind === "offline" ? (selected.query.data?.cachedAt ?? null) : null}
      chatLatest={chatLatest}
      editing={editing}
      setEditing={setEditing}
      onValueChange={onValueChange}
    />
  );
}

function ArtifactView({
  detail,
  cachedAt,
  chatLatest,
  editing,
  setEditing,
  onValueChange,
}: {
  detail: ArtifactDetail;
  cachedAt: string | null;
  chatLatest: number;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  onValueChange: (value: ArtifactSelection) => void;
}) {
  const env = useArtifactsEnv();
  const t = useText();
  const convertText = useConvertText();
  const queryClient = useQueryClient();
  const { artifact, version, access } = detail;
  const content = version.content;
  const [pageErrors, setPageErrors] = useState<ArtifactPageError[]>([]);
  const [showSource, setShowSource] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [status, setStatus] = useState("");
  const versionId = useId();
  const onErrors = useCallback((errors: ArtifactPageError[]) => setPageErrors(errors), []);

  const versions = useQuery({
    ...env.api.artifacts.versions.list.queryOptions({ input: { id: artifact.id } }),
    enabled: !env.offline,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: env.api.artifacts.key() });
  const duplicate = useMutation(
    env.api.artifacts.duplicate.mutationOptions({ onSuccess: () => setStatus(t.duplicated) }),
  );
  const remove = useMutation(
    env.api.artifacts.delete.mutationOptions({
      onSuccess: () => {
        setConfirmDelete(false);
        void refresh();
      },
    }),
  );

  const latest = Math.max(artifact.latestVersion, chatLatest);
  const offline = env.offline;
  const Icon = ARTIFACT_TYPE_ICON[artifact.type];
  const actionError = duplicate.error ?? remove.error;
  const toolbarLink = buttonVariants({ variant: "outline", size: "sm" });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="flex items-center gap-2 font-heading text-base font-semibold break-words">
            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            {artifact.title}
          </h3>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Pill>{t.scope[artifact.scope]}</Pill>
            <span className="font-mono text-muted-foreground">
              {t.version(version.version)} · {artifact.type}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor={versionId}>{t.versions}</label>
          <NativeSelect
            id={versionId}
            size="sm"
            className="w-auto"
            value={String(version.version)}
            disabled={offline || editing}
            onChange={(e) => onValueChange({ id: artifact.id, version: Number(e.target.value) })}
          >
            {(versions.data ?? [{ version: version.version, name: null }]).map((v) => (
              <NativeSelectOption key={v.version} value={String(v.version)}>
                {t.version(v.version)}
                {v.name ? ` · ${v.name}` : ""}
                {v.version === artifact.latestVersion ? ` (${t.latest})` : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>

      <div role="toolbar" aria-label={t.panel} className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={content === null}
          onClick={() =>
            content !== null &&
            navigator.clipboard.writeText(content).then(
              () => setStatus(t.copied),
              () => setStatus(t.copyFailed),
            )
          }
        >
          <CopyIcon aria-hidden />
          {t.copy}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={content === null}
          onClick={() => content !== null && downloadText(artifactFileName(artifact), content)}
        >
          <DownloadIcon aria-hidden />
          {t.download}
        </Button>
        {access.write && (
          <Button
            variant="outline"
            size="sm"
            // Offline không sửa: không gộp được xung đột khi chưa thấy bản mới nhất (spec, mục trường hợp biên).
            disabled={offline || editing || content === null}
            onClick={() => setEditing(true)}
          >
            <PencilIcon aria-hidden />
            {t.edit}
          </Button>
        )}
        {access.manage && (
          <Button variant="outline" size="sm" disabled={offline} onClick={() => setSharing(true)}>
            <Share2Icon aria-hidden />
            {t.share}
          </Button>
        )}
        {artifact.type === "markdown" && content !== null && (
          <Button variant="outline" size="sm" disabled={offline} onClick={() => setConverting(true)}>
            <FileTextIcon aria-hidden />
            {convertText.convert}
          </Button>
        )}
        {access.owner && env.onPublicLinks && (
          <Button
            variant="outline"
            size="sm"
            disabled={offline}
            onClick={() => env.onPublicLinks?.(artifact, version.version)}
          >
            <GlobeIcon aria-hidden />
            {t.publicLinks}
          </Button>
        )}
        {env.link({
          to: { kind: "artifact", id: artifact.id, version: version.version },
          className: toolbarLink,
          children: (
            <>
              <ExpandIcon aria-hidden />
              {t.fullscreen}
            </>
          ),
        })}
        <Button variant="outline" size="sm" aria-pressed={showSource} onClick={() => setShowSource(!showSource)}>
          <FileCodeIcon aria-hidden />
          {t.source}
        </Button>
      </div>

      {cachedAt && (
        <Pill className="self-start">
          {t.cachedAt}{" "}
          <time dateTime={cachedAt}>
            {new Intl.DateTimeFormat(env.lang === "en" ? "en-GB" : "vi-VN", {
              dateStyle: "short",
              timeStyle: "short",
            }).format(new Date(cachedAt))}
          </time>
        </Pill>
      )}

      {latest > version.version && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
        >
          <span className="flex-1">{editing ? t.editingNewer(latest) : t.newer(latest)}</span>
          {!editing && (
            <Button variant="outline" size="sm" onClick={() => onValueChange({ id: artifact.id, version: latest })}>
              {t.openVersion(latest)}
            </Button>
          )}
        </div>
      )}

      {pageErrors.length > 0 && <PageErrors detail={detail} errors={pageErrors} />}

      {editing ? (
        <ArtifactEditor
          artifact={artifact}
          version={version}
          onCancel={() => setEditing(false)}
          onSaved={(result) => {
            setEditing(false);
            void refresh();
            onValueChange({ id: artifact.id, version: result.version.version });
          }}
        />
      ) : showSource && content !== null ? (
        <CodeViewer content={content} language={sourceLanguage(artifact)} />
      ) : (
        <ArtifactViewer artifact={artifact} version={version} onErrors={onErrors} />
      )}

      {status && (
        <p role="status" aria-live="polite" className="rounded-md bg-success-soft px-3 py-2 text-sm text-success">
          {status}
        </p>
      )}
      {actionError != null && (
        <p role="alert" className="rounded-md bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {env.errorMessage(actionError)}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={offline || duplicate.isPending}
          onClick={() => duplicate.mutate({ id: artifact.id, version: version.version })}
        >
          {t.duplicate}
        </Button>
        {access.manage && (
          <Button variant="destructive" size="sm" disabled={offline} onClick={() => setConfirmDelete(true)}>
            {t.delete}
          </Button>
        )}
      </div>
      {confirmDelete && (
        <div role="alert" className="flex flex-col gap-2 rounded-md bg-warning-soft p-3 text-sm text-warning">
          <p>{t.deleteWarn}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive-solid"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ id: artifact.id })}
            >
              {t.confirmDelete}
            </Button>
          </div>
        </div>
      )}

      <ShareDialog artifact={artifact} version={version.version} open={sharing} onOpenChange={setSharing} />
      <ConvertDialog artifact={artifact} version={version.version} open={converting} onOpenChange={setConverting} />
    </div>
  );
}

/**
 * Lỗi trang (≤ 20, chữ do trang viết nên chỉ hiện dạng text) và nút "Nhờ Leader sửa" (FR-150). Người không dùng được
 * Leader vẫn thấy nút nhưng tắt kèm lý do, để biết vì sao không nhờ được.
 */
function PageErrors({ detail, errors }: { detail: ArtifactDetail; errors: ArtifactPageError[] }) {
  const env = useArtifactsEnv();
  const t = useText();
  const canAsk = env.canAskLeader && !!env.onAskLeaderFix;
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-md bg-destructive-soft p-3 text-sm text-destructive">
      <strong>{t.pageErrors}</strong>
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
        {errors.map((error, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ thêm vào cuối trong một lần nạp khung.
          <li key={i} className="font-mono text-xs break-words whitespace-pre-wrap">
            {error.message}
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={!canAsk || env.offline}
        onClick={() => env.onAskLeaderFix?.({ artifact: detail.artifact, version: detail.version.version, errors })}
      >
        <SparklesIcon aria-hidden />
        {t.fix}
      </Button>
      {!env.canAskLeader && <p>{t.missingLeader}</p>}
    </div>
  );
}
