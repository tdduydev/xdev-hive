export interface ArtifactDetailProps {
  id: string;
  /** Bỏ trống là bản mới nhất. */
  version?: number | undefined;
  onVersionChange?: ((version: number) => void) | undefined;
}

const detailText = {
  vi: {
    back: "Về thư viện",
    tabs: "Vùng chi tiết artifact",
    content: "Nội dung",
    versions: "Phiên bản",
    links: "Liên kết",
    activity: "Hoạt động",
    linksHelp: "Xoá cuộc trò chuyện chỉ gỡ liên kết, không xoá artifact.",
    noLinks: "Artifact chưa có liên kết.",
    unavailable: "Không còn truy cập được đích liên kết.",
    noActivity: "Chưa có hoạt động trong thời hạn nhật ký.",
    activityHelp: "Nhật ký trong 365 ngày gần nhất, theo quyền đọc nhật ký của bạn.",
    more: "Tải thêm",
    kinds: {
      chat_thread: "Cuộc trò chuyện",
      terminal_session: "Phiên terminal",
      run: "Run",
      task: "Task",
      sdlc_item: "Hạng mục AI SDLC",
      doc: "Tài liệu",
    },
    actions: {
      "artifact.create": "Tạo artifact",
      "artifact.update": "Lưu phiên bản",
      "artifact.version": "Lưu phiên bản",
      "artifact.rename": "Đổi tiêu đề",
      "artifact.delete": "Xoá artifact",
      "artifact.restore": "Khôi phục artifact",
      "artifact.purge": "Xoá hẳn artifact",
      "artifact.duplicate": "Nhân bản artifact",
      "artifact.scope.change": "Đổi phạm vi",
      "artifact.owner.change": "Chuyển chủ",
      "artifact.version.rename": "Đặt tên phiên bản",
      "artifact.version.restore": "Khôi phục phiên bản",
      "artifact.version.tombstone": "Xoá nội dung phiên bản",
      "artifact.link.add": "Gắn liên kết",
      "artifact.link.remove": "Bỏ gắn liên kết",
      "artifact.public_link.create": "Tạo link công khai",
      "artifact.public_link.revoke": "Thu hồi link công khai",
      "artifact.public_link.view": "Xem link công khai",
      "artifact.secret.blocked": "Chặn nội dung có bí mật",
    },
    denied: "Bị từ chối",
    ok: "Thành công",
    genericAction: "Thao tác artifact",
  },
  en: {
    back: "Back to library",
    tabs: "Artifact details",
    content: "Content",
    versions: "Versions",
    links: "Links",
    activity: "Activity",
    linksHelp: "Deleting a conversation removes its link, not the artifact.",
    noLinks: "This artifact has no links.",
    unavailable: "The linked destination is no longer accessible.",
    noActivity: "No activity within the log retention period.",
    activityHelp: "Logs from the last 365 days, subject to your audit access.",
    more: "Load more",
    kinds: {
      chat_thread: "Conversation",
      terminal_session: "Terminal session",
      run: "Run",
      task: "Task",
      sdlc_item: "AI SDLC item",
      doc: "Document",
    },
    actions: {
      "artifact.create": "Artifact created",
      "artifact.update": "Version saved",
      "artifact.version": "Version saved",
      "artifact.rename": "Title changed",
      "artifact.delete": "Artifact deleted",
      "artifact.restore": "Artifact restored",
      "artifact.purge": "Artifact permanently deleted",
      "artifact.duplicate": "Artifact duplicated",
      "artifact.scope.change": "Scope changed",
      "artifact.owner.change": "Owner transferred",
      "artifact.version.rename": "Version named",
      "artifact.version.restore": "Version restored",
      "artifact.version.tombstone": "Version content removed",
      "artifact.link.add": "Link added",
      "artifact.link.remove": "Link removed",
      "artifact.public_link.create": "Public link created",
      "artifact.public_link.revoke": "Public link revoked",
      "artifact.public_link.view": "Public link viewed",
      "artifact.secret.blocked": "Content with secrets blocked",
    },
    denied: "Denied",
    ok: "Successful",
    genericAction: "Artifact action",
  },
};

type Tab = "content" | "versions" | "links" | "activity";
const tabs: Tab[] = ["content", "versions", "links", "activity"];

/** Đổi route phải bỏ trạng thái phiên bản/tab cũ, kể cả khi app chủ giữ nguyên component. */
export function ArtifactDetail(props: ArtifactDetailProps) {
  return <DetailPage key={`${props.id}@${props.version ?? "latest"}`} {...props} />;
}

function DetailPage({ id, version, onVersionChange }: ArtifactDetailProps) {
  const env = useArtifactsEnv();
  const t = useText();
  const d = detailText[env.lang];
  const [selectedVersion, setSelectedVersion] = useState(version);
  const [tab, setTab] = useState<Tab>("content");
  const tabId = useId();
  const online = useQuery({
    ...env.api.artifacts.get.queryOptions({
      input: { id, ...(selectedVersion !== undefined && { version: selectedVersion }) },
    }),
    enabled: !env.offline,
  });
  const cache = env.offlineCache;
  const cached = useQuery({
    queryKey: ["artifacts-offline", id, selectedVersion],
    queryFn: (): Promise<CachedArtifact | null> => cache?.get(id, selectedVersion) ?? Promise.resolve(null),
    enabled: env.offline && !!cache,
  });
  useEffect(() => {
    if (online.data) cache?.put(online.data);
  }, [online.data, cache]);
  const query = env.offline ? cached : online;
  const detail = query.data;
  const openVersion = (n: number) => {
    setSelectedVersion(n);
    setTab("content");
    onVersionChange?.(n);
  };
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, current: Tab) => {
    const index = tabs.indexOf(current);
    const next =
      event.key === "ArrowRight"
        ? tabs[(index + 1) % tabs.length]
        : event.key === "ArrowLeft"
          ? tabs[(index + tabs.length - 1) % tabs.length]
          : event.key === "Home"
            ? tabs[0]
            : event.key === "End"
              ? tabs.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`${tabId}-${next}`)?.focus();
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={d.tabs}>
      {env.link({
        to: { kind: "library" },
        className: "self-start text-sm text-primary hover:underline",
        children: `← ${d.back}`,
      })}
      {env.offline && (
        <p role="status" className="rounded-md bg-warning-soft p-3 text-sm text-warning">
          {t.offline}
        </p>
      )}
      {query.isPending && query.fetchStatus !== "idle" ? (
        <p role="status" aria-busy="true">
          {t.loading}
        </p>
      ) : env.offline && !detail ? (
        <p role="status">{t.notCached}</p>
      ) : !detail &&
        typeof query.error === "object" &&
        query.error !== null &&
        "code" in query.error &&
        query.error.code === "NOT_FOUND" ? (
        <p role="status">{t.deleted}</p>
      ) : query.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-destructive">
          <p>{env.errorMessage(query.error)}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t.retry}
          </Button>
        </div>
      ) : detail?.artifact.deletedAt ? (
        <p role="status">{t.deleted}</p>
      ) : (
        detail && (
          <>
            <header>
              <h1 className="break-words font-heading text-xl font-semibold">{detail.artifact.title}</h1>
              <p className="break-words text-sm text-muted-foreground">
                {detail.artifact.type} · {t.version(detail.version.version)} · {t.scope[detail.artifact.scope]} ·{" "}
                {detail.artifact.owner.name}
                {detail.artifact.project && ` · ${detail.artifact.project.key}`}
              </p>
            </header>
            <div role="tablist" aria-label={d.tabs} className="flex flex-wrap gap-1">
              {tabs.map((value) => (
                <Button
                  key={value}
                  role="tab"
                  id={`${tabId}-${value}`}
                  aria-controls={`${tabId}-panel`}
                  aria-selected={tab === value}
                  tabIndex={tab === value ? 0 : -1}
                  variant={tab === value ? "secondary" : "ghost"}
                  className="min-h-11"
                  onClick={() => setTab(value)}
                  onKeyDown={(event) => moveTab(event, value)}
                >
                  {d[value]}
                </Button>
              ))}
            </div>
            <div
              role="tabpanel"
              id={`${tabId}-panel`}
              aria-labelledby={`${tabId}-${tab}`}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Tab đưa bàn phím từ thanh tab tới nội dung được chọn.
              tabIndex={0}
              className="min-w-0"
            >
              {/* Giữ khung đang chạy và bản đang sửa khi người xem đổi tab chi tiết. */}
              <div hidden={tab !== "content"}>
                <ArtifactPanel
                  // Trang chi tiết không nhận thẻ chat mới: bản ghim không được tự nhảy sang bản mới nhất.
                  items={[]}
                  value={{ id, version: detail.version.version }}
                  onValueChange={(value) => openVersion(value.version)}
                />
              </div>
              {tab !== "content" && env.offline ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t.notCached}
                </p>
              ) : tab === "versions" ? (
                <VersionHistory
                  artifactId={id}
                  current={detail.version.version}
                  access={detail.access}
                  onOpen={openVersion}
                />
              ) : tab === "links" ? (
                <DetailLinks detail={detail} />
              ) : tab === "activity" ? (
                <DetailActivity id={id} />
              ) : null}
            </div>
          </>
        )
      )}
    </section>
  );
}

/** Hub giấu tiêu đề đích không đọc được; không tạo đường dẫn khi chỉ còn id. */
function linkTo(kind: ArtifactLinkKind, id: string): ArtifactsLink | null {
  if (kind === "chat_thread") return { kind: "thread", id };
  if (kind === "run") return { kind: "run", id };
  // Env hiện chỉ định tuyến chat/run; giữ tên các đích khác để không đoán route của app chủ.
  return null;
}

function DetailLinks({ detail }: { detail: Detail }) {
  const env = useArtifactsEnv();
  const t = useText();
  const d = detailText[env.lang];
  const links = useQuery(env.api.artifacts.links.list.queryOptions({ input: { id: detail.artifact.id } }));
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="font-heading font-semibold">{d.links}</h2>
      <p className="text-sm text-muted-foreground">{d.linksHelp}</p>
      {links.isPending && <p role="status">{t.loading}</p>}
      {links.isError && (
        <div role="alert" className="text-sm text-destructive">
          <p>{env.errorMessage(links.error)}</p>
          <Button variant="outline" onClick={() => void links.refetch()}>
            {t.retry}
          </Button>
        </div>
      )}
      {links.data?.length === 0 && <p className="text-sm text-muted-foreground">{d.noLinks}</p>}
      <ul className="flex flex-col gap-2">
        {links.data?.map((link) => {
          const to = link.title !== null ? linkTo(link.targetKind, link.targetId) : null;
          return (
            <li key={`${link.targetKind}:${link.targetId}`} className="break-words text-sm">
              <span className="text-muted-foreground">{d.kinds[link.targetKind]} · </span>
              {to
                ? env.link({ to, className: "text-primary hover:underline", children: link.title })
                : (link.title ?? d.unavailable)}
            </li>
          );
        })}
      </ul>
      {detail.access.owner && env.onPublicLinks && (
        <Button
          variant="outline"
          className="min-h-11 self-start"
          onClick={() => env.onPublicLinks?.(detail.artifact, detail.version.version)}
        >
          {t.publicLinks}
        </Button>
      )}
    </section>
  );
}

/** Audit tìm chuỗi con; chỉ hiện dòng khớp chính xác đích artifact để không lẫn nhật ký khác. */
function DetailActivity({ id }: { id: string }) {
  const env = useArtifactsEnv();
  const t = useText();
  const d = detailText[env.lang];
  const activity = useInfiniteQuery(
    env.api.audit.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ q: id, range: 365, limit: 30, ...(cursor && { cursor }) }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const rows = [
    ...new Map(
      activity.data?.pages
        .flatMap((page) => page.items)
        .filter((item) => item.targetId === id && item.action.startsWith("artifact."))
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const action = (item: AuditLogItem) => d.actions[item.action as keyof typeof d.actions] ?? d.genericAction;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="font-heading font-semibold">{d.activity}</h2>
      <p className="text-sm text-muted-foreground">{d.activityHelp}</p>
      {activity.isPending && <p role="status">{t.loading}</p>}
      {activity.isError && (
        <div role="alert" className="text-sm text-destructive">
          <p>{env.errorMessage(activity.error)}</p>
          <Button variant="outline" onClick={() => void activity.refetch()}>
            {t.retry}
          </Button>
        </div>
      )}
      {activity.data && rows.length === 0 && <p className="text-sm text-muted-foreground">{d.noActivity}</p>}
      <ol className="flex flex-col gap-3">
        {rows.map((item) => (
          <li key={item.id} className="break-words border-b border-border pb-2 text-sm">
            <p>
              {action(item)} · {item.actor} · {item.result === "denied" ? d.denied : d.ok}
            </p>
            <time dateTime={item.createdAt} className="text-xs text-muted-foreground">
              {new Date(item.createdAt).toLocaleString(env.lang === "vi" ? "vi-VN" : "en-GB")}
            </time>
          </li>
        ))}
      </ol>
      {activity.hasNextPage && (
        <Button
          variant="outline"
          className="min-h-11 self-start"
          disabled={activity.isFetching}
          onClick={() => void activity.fetchNextPage()}
        >
          {activity.isFetchingNextPage ? t.loading : d.more}
        </Button>
      )}
    </section>
  );
}

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ArtifactLinkKind, AuditLogItem, ArtifactDetail as Detail } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { type ArtifactsLink, type CachedArtifact, useArtifactsEnv, useText } from "./env.tsx";
import { ArtifactPanel } from "./panel.tsx";
import { VersionHistory } from "./versions.tsx";
