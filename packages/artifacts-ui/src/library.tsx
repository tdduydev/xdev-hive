import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ARTIFACT_MVP_SCOPES,
  ARTIFACT_MVP_TYPES,
  type ArtifactListQuery,
  type ArtifactOrigin,
  type ArtifactScope,
  type ArtifactSummary,
  type ArtifactType,
} from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { useEffect, useId, useState } from "react";
import { ARTIFACT_TYPE_ICON } from "./card.tsx";
import { type ArtifactRef, useArtifactsEnv, useText } from "./env.tsx";

export interface ArtifactLibraryProps {
  /** Mở một artifact; bỏ trống thì thẻ dẫn tới trang chi tiết qua `env.link`. */
  onOpen?: ((artifact: ArtifactRef) => void) | undefined;
}

// Giữ chữ riêng của T022 để các làn điền T021/T023 không cùng sửa từ điển chung.
const libraryText = {
  vi: {
    help: "Bản làm việc bạn sở hữu hoặc được chia sẻ trong dự án.",
    active: "Đang dùng",
    trash: "Thùng rác",
    trashHelp:
      "Khôi phục trong 30 ngày. Xoá cuộc trò chuyện không xoá artifact; link đã thu hồi không tự hoạt động lại.",
    search: "Tìm theo tiêu đề hoặc nội dung",
    scope: "Phạm vi",
    type: "Loại",
    origin: "Nguồn",
    project: "Dự án",
    all: "Tất cả",
    mine: "Của tôi",
    owner: "Chủ artifact",
    updated: "Sửa gần nhất ↓",
    restore: "Khôi phục",
    restored: "Đã khôi phục artifact.",
    more: "Tải thêm",
    noResults: "Không có kết quả phù hợp",
    emptyTrash: "Thùng rác trống",
    reset: "Bỏ bộ lọc",
    projectsError: "Không tải được danh sách dự án.",
    count: (n: number) => `Đã tải ${n} artifact`,
    origins: { leader: "Leader", terminal: "Terminal", run: "Run", mcp: "MCP", manual: "Tạo tay" },
  },
  en: {
    help: "Working drafts you own or can access in a project.",
    active: "Active",
    trash: "Trash",
    trashHelp: "Restore within 30 days. Deleting a conversation keeps its artifacts; revoked links stay revoked.",
    search: "Search title or content",
    scope: "Scope",
    type: "Type",
    origin: "Origin",
    project: "Project",
    all: "All",
    mine: "Mine",
    owner: "Artifact owner",
    updated: "Last updated ↓",
    restore: "Restore",
    restored: "Artifact restored.",
    more: "Load more",
    noResults: "No matching artifacts",
    emptyTrash: "Trash is empty",
    reset: "Clear filters",
    projectsError: "Could not load projects.",
    count: (n: number) => `${n} artifacts loaded`,
    origins: { leader: "Leader", terminal: "Terminal", run: "Run", mcp: "MCP", manual: "Manual" },
  },
};

const origins: ArtifactOrigin[] = ["leader", "terminal", "run", "mcp", "manual"];

/** Lọc ở hub để kết quả tìm nội dung, quyền đọc và thứ tự con trỏ không lệch giữa các trang. */
export function ArtifactLibrary({ onOpen }: ArtifactLibraryProps) {
  const env = useArtifactsEnv();
  const t = useText();
  const l = libraryText[env.lang];
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [trash, setTrash] = useState(false);
  const [mine, setMine] = useState(false);
  const [scope, setScope] = useState<ArtifactScope | "">("");
  const [type, setType] = useState<ArtifactType | "">("");
  const [origin, setOrigin] = useState<ArtifactOrigin | "">("");
  const [projectKey, setProjectKey] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const input: ArtifactListQuery = {
    trash,
    mine,
    limit: 30,
    ...(scope && { scope }),
    ...(type && { type }),
    ...(origin && { origin }),
    ...(projectKey && { projectKey }),
    ...(query && { query }),
  };
  const list = useInfiniteQuery({
    ...env.api.artifacts.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ ...input, ...(cursor && { cursor }) }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    enabled: !env.offline,
  });
  const projects = useQuery({
    ...env.api.projects.list.queryOptions({ input: {} }),
    enabled: !env.offline,
  });
  const restore = useMutation({
    ...env.api.artifacts.restore.mutationOptions(),
    onSuccess: async () => {
      setMessage(l.restored);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: env.api.artifacts.list.key() }),
        queryClient.invalidateQueries({ queryKey: env.api.artifacts.get.key() }),
      ]);
    },
  });
  const rows = [...new Map(list.data?.pages.flatMap((page) => page.items).map((item) => [item.id, item])).values()];
  const filtered = !!(mine || scope || type || origin || projectKey || search.trim());
  const date = (at: string) => new Date(at).toLocaleString(env.lang === "vi" ? "vi-VN" : "en-GB");
  const reset = () => {
    setMine(false);
    setScope("");
    setType("");
    setOrigin("");
    setProjectKey("");
    setSearch("");
    setQuery("");
  };
  const open = (artifact: ArtifactSummary) => {
    const ref = { id: artifact.id, version: artifact.latestVersion, title: artifact.title, type: artifact.type };
    if (onOpen)
      return (
        <Button
          variant="link"
          className="h-auto justify-start whitespace-normal p-0 text-left"
          onClick={() => onOpen(ref)}
        >
          {artifact.title}
        </Button>
      );
    return env.link({
      to: { kind: "artifact", id: artifact.id },
      className: "break-words font-medium text-primary hover:underline",
      children: artifact.title,
    });
  };
  const description = (artifact: ArtifactSummary) => {
    const Icon = ARTIFACT_TYPE_ICON[artifact.type];
    return (
      <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
        <Icon aria-hidden className="size-4" />
        {artifact.type} · {t.version(artifact.latestVersion)}
      </span>
    );
  };
  const restoreButton = (artifact: ArtifactSummary) => (
    <Button
      variant="outline"
      className="min-h-11"
      disabled={env.offline || restore.isPending}
      onClick={() => {
        setMessage("");
        restore.mutate({ id: artifact.id });
      }}
    >
      {l.restore}
    </Button>
  );

  return (
    <section aria-label="Artifact" className="@container flex min-w-0 flex-col gap-4">
      <header>
        <h1 className="font-heading text-xl font-semibold">Artifact</h1>
        <p className="text-sm text-muted-foreground">{l.help}</p>
      </header>
      <nav aria-label="Artifact" className="flex gap-2">
        {[false, true].map((value) => (
          <Button
            key={String(value)}
            variant={trash === value ? "secondary" : "ghost"}
            className="min-h-11"
            aria-pressed={trash === value}
            onClick={() => {
              setTrash(value);
              setMessage("");
              restore.reset();
            }}
          >
            {value ? l.trash : l.active}
          </Button>
        ))}
      </nav>
      <div className="grid min-w-0 gap-3 @min-[640px]:grid-cols-3">
        <label htmlFor={`${fieldId}-search`} className="flex flex-col gap-1 text-sm">
          {l.search}
          <Input
            id={`${fieldId}-search`}
            type="search"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-h-11"
          />
        </label>
        <label htmlFor={`${fieldId}-scope`} className="flex flex-col gap-1 text-sm">
          {l.scope}
          <NativeSelect
            id={`${fieldId}-scope`}
            className="min-h-11"
            value={scope}
            onChange={(event) => setScope(event.target.value as ArtifactScope | "")}
          >
            <NativeSelectOption value="">{l.all}</NativeSelectOption>
            {ARTIFACT_MVP_SCOPES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {t.scope[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label htmlFor={`${fieldId}-type`} className="flex flex-col gap-1 text-sm">
          {l.type}
          <NativeSelect
            id={`${fieldId}-type`}
            className="min-h-11"
            value={type}
            onChange={(event) => setType(event.target.value as ArtifactType | "")}
          >
            <NativeSelectOption value="">{l.all}</NativeSelectOption>
            {ARTIFACT_MVP_TYPES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label htmlFor={`${fieldId}-origin`} className="flex flex-col gap-1 text-sm">
          {l.origin}
          <NativeSelect
            id={`${fieldId}-origin`}
            className="min-h-11"
            value={origin}
            onChange={(event) => setOrigin(event.target.value as ArtifactOrigin | "")}
          >
            <NativeSelectOption value="">{l.all}</NativeSelectOption>
            {origins.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {l.origins[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label htmlFor={`${fieldId}-project`} className="flex flex-col gap-1 text-sm">
          {l.project}
          <NativeSelect
            id={`${fieldId}-project`}
            className="min-h-11"
            value={projectKey}
            disabled={env.offline || projects.isPending || projects.isError}
            onChange={(event) => setProjectKey(event.target.value)}
          >
            <NativeSelectOption value="">{l.all}</NativeSelectOption>
            {projects.data?.map((project) => (
              <NativeSelectOption key={project.id} value={project.key}>
                {project.name} · {project.key}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
          {l.mine}
        </label>
      </div>
      {projects.isError && !env.offline && (
        <div role="alert" className="text-sm text-destructive">
          {l.projectsError}{" "}
          <Button variant="link" onClick={() => void projects.refetch()}>
            {t.retry}
          </Button>
        </div>
      )}
      {env.offline && (
        <p role="status" className="rounded-md bg-warning-soft p-3 text-sm text-warning">
          {t.offline}
        </p>
      )}
      {trash && <p className="rounded-md bg-warning-soft p-3 text-sm text-warning">{l.trashHelp}</p>}
      {message && (
        <p role="status" className="text-sm text-success">
          {message}
        </p>
      )}
      {restore.isError && (
        <p role="alert" className="text-sm text-destructive">
          {env.errorMessage(restore.error)}
        </p>
      )}
      {list.isPending && !env.offline && (
        <p role="status" aria-busy="true">
          {t.loading}
        </p>
      )}
      {list.isError && !env.offline && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <p>{env.errorMessage(list.error)}</p>
          <Button variant="outline" onClick={() => void list.refetch()}>
            {t.retry}
          </Button>
        </div>
      )}
      {list.data && rows.length === 0 && (
        <div className="rounded-lg border border-border p-8 text-center">
          <h2 className="font-heading font-semibold">{filtered ? l.noResults : trash ? l.emptyTrash : t.empty}</h2>
          <p className="text-sm text-muted-foreground">{filtered ? l.reset : trash ? l.trashHelp : t.emptyHelp}</p>
          {filtered && (
            <Button variant="outline" onClick={reset}>
              {l.reset}
            </Button>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {l.count(rows.length)}
          </p>
          <div className="hidden @min-[640px]:block">
            <table className="w-full table-fixed text-sm">
              <caption className="sr-only">{l.help}</caption>
              <thead>
                <tr>
                  {["Artifact", l.scope, l.owner, l.origin, l.updated, ...(trash ? [l.restore] : [])].map((label) => (
                    <th key={label} scope="col" className="border-b border-border p-2 text-left font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((artifact) => (
                  <tr key={artifact.id} className="border-b border-border">
                    <td className="break-words p-2">
                      {open(artifact)}
                      {description(artifact)}
                    </td>
                    <td className="break-words p-2">
                      {t.scope[artifact.scope]}
                      {artifact.project && (
                        <p className="font-mono text-xs text-muted-foreground">{artifact.project.key}</p>
                      )}
                    </td>
                    <td className="break-words p-2">{artifact.owner.name}</td>
                    <td className="p-2">{l.origins[artifact.origin]}</td>
                    <td className="p-2">
                      <time dateTime={artifact.updatedAt}>{date(artifact.updatedAt)}</time>
                    </td>
                    {trash && <td className="p-2">{restoreButton(artifact)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-3 @min-[640px]:hidden">
            {rows.map((artifact) => (
              <article
                key={artifact.id}
                className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3"
              >
                <h2 className="break-words font-medium">{open(artifact)}</h2>
                {description(artifact)}
                <div>
                  <Pill>{t.scope[artifact.scope]}</Pill>
                </div>
                <p className="break-words text-sm text-muted-foreground">
                  {artifact.owner.name} · {l.origins[artifact.origin]}
                  {artifact.project && ` · ${artifact.project.key}`}
                </p>
                <time className="text-xs text-muted-foreground" dateTime={artifact.updatedAt}>
                  {date(artifact.updatedAt)}
                </time>
                {trash && restoreButton(artifact)}
              </article>
            ))}
          </div>
          {list.hasNextPage && (
            <Button
              variant="outline"
              className="min-h-11 self-start"
              disabled={env.offline || list.isFetching}
              onClick={() => void list.fetchNextPage()}
            >
              {list.isFetchingNextPage ? t.loading : l.more}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
