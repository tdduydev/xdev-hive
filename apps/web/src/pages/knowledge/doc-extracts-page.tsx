import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DOC_MAX_CHARS, type DocExtract, docSecretErrorData } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors.ts";
import { findingText } from "@/pages/knowledge/doc-import-tree.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const STATE_LABEL: Record<DocExtract["state"], string> = {
  pending: "Đang trích",
  review: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Đã từ chối",
  failed: "Lỗi",
};
type Filter = DocExtract["state"] | "all";
type Action = "save" | "approve" | "reject" | "confirmSecret";

export function DocExtractsPage() {
  const { api, org } = useOrg();
  const [filter, setFilter] = useState<Filter>("review");
  const [selected, setSelected] = useState<string>();
  const filterId = useId();
  const list = useInfiniteQuery({
    queryKey: [...api.docExtracts.key(), "review-list", filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.docExtracts.list.call({ state: filter === "all" ? undefined : filter, cursor: pageParam, limit: 50 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: filter === "pending" ? 3000 : false,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <PageHeader
        title="Bản trích tài liệu"
        description="Kiểm tra và sửa nội dung trích từ file gốc. Chỉ bản đã duyệt mới được tìm kiếm và cho agent đọc."
        width="wide"
      />
      <PageBody>
        <div className="grid min-w-0 gap-4">
          <Link to="/knowledge/docs" className="w-fit text-sm text-primary underline">
            Về danh sách tài liệu
          </Link>
          <label htmlFor={filterId} className="grid max-w-xs gap-1.5 text-sm">
            Trạng thái bản trích
            <NativeSelect
              id={filterId}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as Filter);
                setSelected(undefined);
              }}
            >
              <option value="all">Tất cả</option>
              {Object.entries(STATE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </label>
          {list.isPending && <LoadingState label="Đang tải bản trích…" />}
          {list.isError && <LoadFailure error={list.error} retry={list.refetch} />}
          {list.isSuccess && !items.length && (
            <EmptyState title="Không có bản trích" description="Chưa có bản trích ở trạng thái này." />
          )}
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <div className="grid content-start gap-2">
              <ul aria-label="Danh sách bản trích" className="grid min-w-0 gap-2">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={selected === item.id}
                      onClick={() => setSelected(item.id)}
                      className="grid w-full min-w-0 gap-1 rounded-lg border border-border p-3 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-primary aria-pressed:bg-muted"
                    >
                      <span className="font-medium break-words">{item.repoPath}</span>
                      <span className="text-xs text-muted-foreground">
                        {STATE_LABEL[item.state]}
                        {item.secretFlag ? " · Có dấu hiệu bí mật" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {list.hasNextPage && (
                <Button variant="outline" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                  Tải thêm bản trích
                </Button>
              )}
            </div>
            {selected ? (
              <ExtractDetail key={`${org.id}:${selected}`} id={selected} />
            ) : (
              items.length > 0 && <p className="text-sm text-muted-foreground">Chọn một bản trích để xem và duyệt.</p>
            )}
          </div>
        </div>
      </PageBody>
    </>
  );
}

function ExtractDetail({ id }: { id: string }) {
  const { api } = useOrg();
  const [notice, setNotice] = useState("");
  const detail = useQuery({ ...api.docExtracts.get.queryOptions({ input: { id } }), refetchOnWindowFocus: false });
  return (
    <section aria-label="Chi tiết bản trích" className="grid min-w-0 content-start gap-3">
      {detail.isPending && <LoadingState label="Đang tải nội dung…" />}
      {detail.isError && <LoadFailure error={detail.error} retry={detail.refetch} />}
      {notice && <p role="status">{notice}</p>}
      {detail.data && (
        <ExtractReview
          key={`${id}:${detail.data.updatedAt}`}
          extract={detail.data}
          reload={detail.refetch}
          onNotice={setNotice}
        />
      )}
    </section>
  );
}

function ExtractReview({
  extract,
  reload,
  onNotice,
}: {
  extract: DocExtract;
  reload: () => unknown;
  onNotice: (message: string) => void;
}) {
  const { api, org } = useOrg();
  const cache = useQueryClient();
  const [content, setContent] = useState(extract.content);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const contentId = useId();
  const dirty = content !== extract.content;
  const editable = extract.state === "review";
  const action = useMutation({
    mutationFn: (kind: Action) => {
      const input = { id: extract.id, updatedAt: extract.updatedAt };
      if (kind === "save") return api.docExtracts.update.call({ ...input, content });
      return api.docExtracts[kind].call(input);
    },
    onSuccess: async (next, kind) => {
      setConfirmOpen(false);
      onNotice(
        {
          save: "Đã lưu bản trích.",
          approve: "Đã duyệt bản trích.",
          reject: "Đã từ chối bản trích.",
          confirmSecret: "Đã xác nhận. Bạn có thể duyệt bản trích.",
        }[kind],
      );
      cache.setQueryData(api.docExtracts.get.queryKey({ input: { id: extract.id } }), next);
      await cache.invalidateQueries({
        queryKey: api.docExtracts.key(),
        predicate: (query) => query.queryKey.includes("review-list"),
      });
    },
  });
  const stale =
    action.isError &&
    (apiErrorCode(action.error) === "VERSION_CONFLICT" ||
      (action.error && "code" in action.error && action.error.code === "CONFLICT"));
  const secret = docSecretErrorData.safeParse(action.error && "data" in action.error ? action.error.data : undefined);
  const findings = secret.success ? secret.data.findings : extract.findings;
  const blocked = extract.secretFlag || secret.success;
  const disabled = action.isPending || Boolean(stale);
  const sourceUrl = `/api/v1/docs/assets/${encodeURIComponent(extract.assetId)}?${new URLSearchParams({ org: org.id })}`;
  return (
    <>
      <h2 className="text-lg font-semibold break-words">{extract.repoPath}</h2>
      <p className="text-sm text-muted-foreground">{STATE_LABEL[extract.state]}</p>
      <a href={sourceUrl} target="_blank" rel="noreferrer" className="w-fit text-sm text-primary underline">
        Xem file gốc
      </a>
      <p className="text-xs text-muted-foreground">Ảnh và PDF mở qua liên kết; các định dạng khác được tải xuống.</p>
      {extract.error && <Alert variant="destructive">{extract.error}</Alert>}
      {extract.warnings.length > 0 && (
        <Alert>
          <ul>
            {extract.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Alert>
      )}
      {blocked && (
        <Alert className="grid justify-items-start gap-2">
          <p>Có dấu hiệu bí mật. Kiểm tra trước khi xác nhận và duyệt.</p>
          <ul>
            {findings.map((finding) => (
              <li key={`${finding.kind}:${finding.line}`}>{findingText(finding)}</li>
            ))}
          </ul>
          {editable && (
            <Button variant="outline" disabled={disabled || dirty} onClick={() => setConfirmOpen(true)}>
              Xác nhận không phải bí mật
            </Button>
          )}
        </Alert>
      )}
      <label htmlFor={contentId} className="text-sm font-medium">
        Nội dung bản trích (Markdown)
      </label>
      <Textarea
        id={contentId}
        value={content}
        maxLength={DOC_MAX_CHARS}
        readOnly={!editable || disabled}
        onChange={(e) => {
          setContent(e.target.value);
          onNotice("");
        }}
        className="min-h-72 w-full min-w-0 font-mono text-sm"
      />
      {stale && (
        <Alert className="grid justify-items-start gap-2">
          Bản trích đã đổi. Tải bản mới nhất để kiểm tra lại; phần sửa chưa lưu sẽ được thay thế.
          <Button variant="outline" onClick={() => reload()}>
            Tải bản mới nhất
          </Button>
        </Alert>
      )}
      {action.isError && !stale && <Alert variant="destructive">{apiErrorMessage(action.error)}</Alert>}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={disabled || !dirty} onClick={() => action.mutate("save")}>
            Lưu bản trích
          </Button>
          <Button variant="outline" disabled={disabled || dirty} onClick={() => action.mutate("reject")}>
            Từ chối bản trích
          </Button>
          <Button disabled={disabled || dirty || blocked} onClick={() => action.mutate("approve")}>
            Duyệt bản trích
          </Button>
        </div>
      )}
      {dirty && (
        <p className="text-xs text-muted-foreground">Lưu thay đổi trước khi duyệt, từ chối hoặc xác nhận bí mật.</p>
      )}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogTitle>Xác nhận dấu hiệu bí mật</DialogTitle>
          <DialogDescription>
            Chỉ xác nhận khi đã kiểm tra nội dung và chắc chắn đây không phải bí mật. Sau đó bạn vẫn cần duyệt bản
            trích.
          </DialogDescription>
          <ul className="text-sm">
            {findings.map((finding) => (
              <li key={`${finding.kind}:${finding.line}`}>{findingText(finding)}</li>
            ))}
          </ul>
          <DialogActions>
            <Button variant="outline" disabled={action.isPending} onClick={() => setConfirmOpen(false)}>
              Huỷ
            </Button>
            <Button disabled={disabled || dirty} onClick={() => action.mutate("confirmSecret")}>
              Không phải bí mật, xác nhận
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
