import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { type DocImport, type DocImportFile, docKey } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useEffect, useId, useMemo, useState } from "react";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { buildTree, DocImportTree, findingText, isImportable } from "@/pages/knowledge/doc-import-tree.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

type Resolution = { action: "rename"; key: string } | { action: "attach"; choice: "hub" | "repo" };

const ACTIVE: ReadonlyArray<DocImport["state"]> = ["scanning", "importing"];
const POLL_MS = 1500;
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function DocImportPage() {
  const { api, org } = useOrg();
  const search = useSearch({ strict: false }) as { project?: unknown };
  const [scope, setScope] = useState(typeof search.project === "string" ? search.project : "");
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const home = useQuery(api.docHomes.get.queryOptions({ input: scope ? { project: scope } : {} }));
  const docProjects = (projects.data ?? []).filter((project) => project.settings.docs.enabled);
  const scopeId = useId();
  return (
    <>
      <PageHeader
        title="Nhập tài liệu từ repo"
        description="Quét repo, chọn file markdown cần đưa vào hub rồi theo dõi tiến độ. File có dấu hiệu bí mật không được nhập cho tới khi quản trị xác nhận."
        width="wide"
      />
      <PageBody>
        <div className="grid min-w-0 gap-4">
          <label htmlFor={scopeId} className="grid max-w-sm gap-1.5 text-sm">
            Nhập vào kho tài liệu của
            <NativeSelect id={scopeId} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">{org.name ? `Tổ chức ${org.name}` : "Tổ chức"}</option>
              {docProjects.map((project) => (
                <option key={project.id} value={project.key}>
                  Dự án {project.name}
                </option>
              ))}
            </NativeSelect>
          </label>
          {home.isPending && <LoadingState label="Đang tải kho tài liệu…" />}
          {home.isError && <LoadFailure error={home.error} retry={home.refetch} />}
          {home.isSuccess && !home.data && (
            <Alert role="note">
              Chưa có kho tài liệu cho phạm vi này.{" "}
              {scope ? (
                <Link to="/projects/$key/settings" params={{ key: scope }} className="text-primary underline">
                  Cấu hình trong cài đặt dự án
                </Link>
              ) : (
                <Link to="/knowledge/skills" className="text-primary underline">
                  Cấu hình ở trang Kiến thức
                </Link>
              )}
              .
            </Alert>
          )}
          {home.data && (
            <ImportFlow
              key={home.data.id}
              homeId={home.data.id}
              defaults={{ include: home.data.include, exclude: home.data.exclude }}
            />
          )}
        </div>
      </PageBody>
    </>
  );
}

function ImportFlow({ homeId, defaults }: { homeId: string; defaults: { include: string[]; exclude: string[] } }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const [include, setInclude] = useState(defaults.include.join("\n"));
  const [exclude, setExclude] = useState(defaults.exclude.join("\n"));
  const [importId, setImportId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [resolutions, setResolutions] = useState<ReadonlyMap<string, Resolution>>(new Map());
  const [secretFile, setSecretFile] = useState<DocImportFile | null>(null);
  const [notice, setNotice] = useState<string>();
  const patternId = useId();

  // Lần nhập dở (quét xong chưa nhập, hoặc đang chạy) tiếp tục được sau khi tải lại trang.
  const latest = useQuery(api.docImports.list.queryOptions({ input: { homeId, limit: 1 } }));
  const resumable = latest.data?.items.find(
    (item) => item.state !== "done" && item.state !== "failed" && item.state !== "cancelled",
  );
  const activeId = importId ?? resumable?.id ?? null;
  const current = useQuery({
    ...api.docImports.get.queryOptions({ input: { id: activeId ?? "" } }),
    enabled: activeId !== null,
    refetchInterval: (query) => (query.state.data && ACTIVE.includes(query.state.data.state) ? POLL_MS : false),
  });
  const run = current.data;
  const loaded = run && run.state !== "scanning";
  const files = useInfiniteQuery({
    // updatedAt trong khoá để danh sách tải lại khi tiến độ đổi.
    queryKey: [...api.docImports.key(), "files", activeId, run?.updatedAt],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.docImports.files.call({ id: activeId ?? "", cursor: pageParam, limit: 200 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: activeId !== null && Boolean(loaded),
  });
  // Chọn cả thư mục chỉ đúng khi đã có đủ file, nên tải hết các trang.
  useEffect(() => {
    if (files.hasNextPage && !files.isFetchingNextPage && !files.isError) void files.fetchNextPage();
  }, [files.hasNextPage, files.isFetchingNextPage, files.isError, files.fetchNextPage]);
  const allFiles = useMemo(() => files.data?.pages.flatMap((page) => page.items) ?? [], [files.data]);
  const tree = useMemo(() => buildTree(allFiles), [allFiles]);
  const resolved = useMemo(() => {
    const set = new Set<string>();
    for (const [path, value] of resolutions) {
      if (value.action === "attach" || docKey.safeParse(value.key).success) set.add(path);
    }
    return set;
  }, [resolutions]);
  const importable = (file: DocImportFile) => isImportable(file, resolved);
  const effective = useMemo(
    () => selected ?? new Set(allFiles.filter((file) => isImportable(file, resolved)).map((file) => file.path)),
    [selected, allFiles, resolved],
  );
  const chosen = allFiles.filter((file) => effective.has(file.path) && isImportable(file, resolved));

  const scan = useMutation({
    mutationFn: () => api.docImports.scan.call({ homeId, include: lines(include), exclude: lines(exclude) }),
    onSuccess: (next) => {
      setImportId(next.id);
      setSelected(null);
      setResolutions(new Map());
      setNotice(undefined);
      cache.setQueryData(api.docImports.get.queryKey({ input: { id: next.id } }), next);
    },
  });
  const start = useMutation({
    mutationFn: async () => {
      if (!run) throw new Error("Chưa có bản quét.");
      const picked = new Set(chosen.map((file) => file.path));
      const list = [];
      for (const file of allFiles) {
        const value = resolutions.get(file.path);
        if (!value || !picked.has(file.path) || !file.existingKey) continue;
        if (value.action === "rename") list.push({ path: file.path, action: "rename" as const, key: value.key });
        else {
          const existing = await api.docs.get.call({ key: file.existingKey });
          list.push({
            path: file.path,
            action: "attach" as const,
            key: file.existingKey,
            choice: value.choice,
            baseVersion: existing.version,
          });
        }
      }
      return api.docImports.start.call({
        importId: run.id,
        paths: [...picked],
        ...(list.length > 0 ? { resolutions: list } : {}),
      });
    },
    onSuccess: (next) => cache.setQueryData(api.docImports.get.queryKey({ input: { id: next.id } }), next),
  });
  const cancel = useMutation({
    mutationFn: () => api.docImports.cancel.call({ id: activeId ?? "" }),
    onSuccess: (next) => cache.setQueryData(api.docImports.get.queryKey({ input: { id: next.id } }), next),
  });
  const confirm = useMutation({
    mutationFn: (file: DocImportFile) =>
      api.docImports.confirmSecret.call({ importId: activeId ?? "", path: file.path }),
    onSuccess: async () => {
      setSecretFile(null);
      setNotice("Đã xếp nhập lại file này.");
      await cache.invalidateQueries({ queryKey: api.docImports.key() });
    },
  });

  const busy = run ? ACTIVE.includes(run.state) : false;
  const finished = run ? ["done", "failed", "cancelled"].includes(run.state) : false;
  return (
    <div className="grid min-w-0 gap-4">
      <section aria-label="Phạm vi quét" className="grid gap-3 rounded-xl border border-border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label htmlFor={`${patternId}-include`} className="grid gap-1.5 text-sm">
            Mẫu lấy
            <Textarea
              id={`${patternId}-include`}
              rows={4}
              value={include}
              disabled={busy || scan.isPending}
              onChange={(e) => setInclude(e.target.value)}
            />
          </label>
          <label htmlFor={`${patternId}-exclude`} className="grid gap-1.5 text-sm">
            Mẫu bỏ
            <Textarea
              id={`${patternId}-exclude`}
              rows={4}
              value={exclude}
              disabled={busy || scan.isPending}
              onChange={(e) => setExclude(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">Mỗi dòng một mẫu glob, ví dụ docs/** hoặc **/*.md.</p>
        {scan.isError && <Alert variant="destructive">{apiErrorMessage(scan.error)}</Alert>}
        <div>
          <Button disabled={busy || scan.isPending} onClick={() => scan.mutate()}>
            {run ? "Quét lại" : "Quét repo"}
          </Button>
        </div>
      </section>

      {activeId && current.isPending && <LoadingState label="Đang tải lần nhập…" />}
      {current.isError && <LoadFailure error={current.error} retry={current.refetch} />}
      {run?.state === "scanning" && <LoadingState label="Đang quét repo…" />}
      {run?.state === "failed" && <Alert variant="destructive">{run.error ?? "Lần nhập thất bại."}</Alert>}
      {run?.state === "importing" && (
        <section aria-label="Tiến độ nhập" className="grid gap-2 rounded-xl border border-border bg-card p-4">
          <Progress value={run.progress.total ? (run.progress.done / run.progress.total) * 100 : 0}>
            <ProgressLabel>
              Đã nhập {run.progress.done}/{run.progress.total} file
            </ProgressLabel>
            <ProgressValue />
          </Progress>
          {cancel.isError && <Alert variant="destructive">{apiErrorMessage(cancel.error)}</Alert>}
          <div>
            <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Huỷ lần nhập
            </Button>
          </div>
        </section>
      )}
      {finished && run?.report && <ImportReport report={run.report} cancelled={run.state === "cancelled"} />}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      {loaded && (
        <section aria-label="Chọn file" className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-4">
          {files.isPending && <LoadingState label="Đang tải danh sách file…" />}
          {files.isError && <LoadFailure error={files.error} retry={files.refetch} />}
          {files.isSuccess && allFiles.length === 0 && <p className="text-sm">Không có file nào khớp mẫu lấy và bỏ.</p>}
          {allFiles.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm" aria-live="polite">
                  Đã chọn {chosen.length}/{allFiles.length} file
                  {files.hasNextPage ? " (đang tải thêm…)" : ""}
                </p>
                {run.state === "ready" && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelected(new Set(allFiles.filter(importable).map((file) => file.path)))}
                    >
                      Chọn tất cả
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
                      Bỏ chọn hết
                    </Button>
                  </>
                )}
              </div>
              <DocImportTree
                root={tree}
                selected={effective}
                onSelectedChange={setSelected}
                importable={importable}
                disabled={run.state !== "ready" || start.isPending}
                fileExtra={(file) => (
                  <FileActions
                    file={file}
                    canResolve={run.state === "ready"}
                    resolution={resolutions.get(file.path)}
                    onResolve={(value) => {
                      setResolutions((map) => new Map(map).set(file.path, value));
                      if (value.action === "attach" || docKey.safeParse(value.key).success) {
                        setSelected((current) => new Set(current ?? effective).add(file.path));
                      }
                    }}
                    onConfirmSecret={() => {
                      confirm.reset();
                      setSecretFile(file);
                    }}
                  />
                )}
              />
              {start.isError && <Alert variant="destructive">{apiErrorMessage(start.error)}</Alert>}
              {run.state === "ready" && (
                <div>
                  <Button
                    disabled={chosen.length === 0 || start.isPending || files.hasNextPage}
                    onClick={() => start.mutate()}
                  >
                    {start.isPending ? "Đang xếp việc…" : `Nhập ${chosen.length} file`}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <Dialog open={secretFile !== null} onOpenChange={(open) => !open && !confirm.isPending && setSecretFile(null)}>
        <DialogContent>
          <DialogTitle>Không phải bí mật, vẫn nhập?</DialogTitle>
          <DialogDescription>
            Hub chặn {secretFile?.path} vì có chuỗi giống bí mật ({secretFile?.findings.map(findingText).join(", ")}).
            Nếu đó là bí mật thật thì nó đã nằm trong lịch sử git của repo: nhập vào hub không gỡ được, bạn cần thu hồi
            hoặc đổi khoá ngay. Chỉ tiếp tục khi chắc đây không phải bí mật. Thao tác này được ghi vào nhật ký.
          </DialogDescription>
          {confirm.isError && <Alert variant="destructive">{apiErrorMessage(confirm.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" disabled={confirm.isPending} onClick={() => setSecretFile(null)}>
              Huỷ
            </Button>
            <Button disabled={confirm.isPending} onClick={() => secretFile && confirm.mutate(secretFile)}>
              Không phải bí mật, vẫn nhập
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ImportReport({ report, cancelled }: { report: NonNullable<DocImport["report"]>; cancelled: boolean }) {
  const cells = [
    ["Đã nhập", report.imported],
    ["Bỏ qua", report.skipped],
    ["Bị chặn vì bí mật", report.blockedSecret],
    ["Lỗi", report.failed],
  ] as const;
  return (
    <section aria-label="Báo cáo nhập" className="grid gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">{cancelled ? "Báo cáo (đã huỷ giữa chừng)" : "Báo cáo nhập"}</h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cells.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      {report.blockedSecret > 0 && (
        <Alert role="note">
          Các file bị chặn không được nhập. Nếu bí mật là thật thì nó đã nằm trong lịch sử git, hãy thu hồi hoặc đổi
          khoá.
        </Alert>
      )}
      {report.warnings.length > 0 && (
        <ul className="grid list-disc gap-1 pl-5 text-sm text-muted-foreground">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FileActions({
  file,
  canResolve,
  resolution,
  onResolve,
  onConfirmSecret,
}: {
  file: DocImportFile;
  canResolve: boolean;
  resolution: Resolution | undefined;
  onResolve: (value: Resolution) => void;
  onConfirmSecret: () => void;
}) {
  const id = useId();
  const blocked = file.state === "blocked_secret" || (file.state === "pending" && file.secretScan === "found");
  if (blocked) {
    return (
      <Button variant="outline" size="sm" onClick={onConfirmSecret}>
        Không phải bí mật, vẫn nhập
      </Button>
    );
  }
  if (file.state !== "pending" || !file.existingKey) return null;
  const rename = resolution?.action === "rename" ? resolution.key : (file.key ?? file.existingKey);
  const invalid = resolution?.action === "rename" && !docKey.safeParse(resolution.key).success;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={`${id}-how`} className="text-muted-foreground">
        Trùng key {file.existingKey}
      </label>
      <NativeSelect
        id={`${id}-how`}
        value={resolution ? (resolution.action === "rename" ? "rename" : resolution.choice) : ""}
        disabled={!canResolve}
        onChange={(e) => {
          const value = e.target.value;
          if (value === "rename") onResolve({ action: "rename", key: `${rename}-2` });
          else if (value === "hub" || value === "repo") onResolve({ action: "attach", choice: value });
        }}
      >
        <option value="" disabled>
          Chọn cách xử lý
        </option>
        <option value="rename">Nhập thành tài liệu mới với key khác</option>
        <option value="hub">Gắn vào tài liệu có sẵn, giữ bản hub</option>
        <option value="repo">Gắn vào tài liệu có sẵn, lấy bản repo</option>
      </NativeSelect>
      {resolution?.action === "rename" && (
        <Input
          aria-label={`Key mới cho ${file.path}`}
          aria-invalid={invalid}
          className="w-72 max-w-full"
          value={resolution.key}
          disabled={!canResolve}
          onChange={(e) => onResolve({ action: "rename", key: e.target.value })}
        />
      )}
      {invalid && <span className="text-xs text-destructive">Key không hợp lệ.</span>}
    </div>
  );
}
