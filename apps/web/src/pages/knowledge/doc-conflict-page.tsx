import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { type DocConflictDetail, type DocConflictResolveInput, docSecretErrorData } from "@xdev-hive/contracts";
import { type ConflictResolution, ConflictView } from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { useState } from "react";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorCode, apiErrorMessage } from "@/lib/api-errors.ts";
import { findingText } from "@/pages/knowledge/doc-import-tree.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

export function DocConflictPage() {
  const { id } = useParams({ from: "/session/app/in-org/knowledge/docs/conflicts/$id" });
  const { api, org } = useOrg();
  const conflict = useQuery({
    ...api.docConflicts.get.queryOptions({ input: { id } }),
    // Người dùng chủ động tải lại để bản đang sửa không mất khi đổi cửa sổ.
    refetchOnWindowFocus: false,
  });
  return (
    <>
      <PageHeader title="Giải quyết xung đột tài liệu" description={conflict.data?.repoPath} width="wide" />
      <PageBody>
        {conflict.isPending && <LoadingState label="Đang tải ba bản tài liệu…" />}
        {conflict.isError && <LoadFailure error={conflict.error} retry={conflict.refetch} />}
        {conflict.data && (
          <ConflictReview
            key={`${org.id}:${id}:${conflict.data.updatedAt}:${conflict.data.hubVersion}:${conflict.data.repoCommit}`}
            conflict={conflict.data}
            reload={conflict.refetch}
          />
        )}
      </PageBody>
    </>
  );
}

function ConflictReview({ conflict, reload }: { conflict: DocConflictDetail; reload: () => unknown }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const [attempt, setAttempt] = useState<DocConflictResolveInput>();
  const [resolved, setResolved] = useState(false);
  const resolve = useMutation({
    mutationFn: (input: DocConflictResolveInput) => api.docConflicts.resolve.call(input),
    onSuccess: async () => {
      setAttempt(undefined);
      setResolved(true);
      await Promise.all([
        cache.invalidateQueries({ queryKey: api.docTree.key() }),
        cache.invalidateQueries({ queryKey: api.docs.key() }),
        cache.invalidateQueries({ queryKey: api.docHomes.key() }),
        cache.invalidateQueries({ queryKey: api.docConflicts.key() }),
      ]);
    },
  });
  const word = conflict.origin === "word";
  const stale = ["VERSION_CONFLICT", "DOCSYNC_CONFLICT_RESOLVED"].includes(apiErrorCode(resolve.error) ?? "");
  const secret = docSecretErrorData.safeParse(
    resolve.error && "data" in resolve.error ? resolve.error.data : undefined,
  );
  const submit = (choice: ConflictResolution) => {
    const input = { ...choice, id: conflict.id, baseVersion: conflict.hubVersion };
    setAttempt(input);
    resolve.mutate(input);
  };
  return (
    <div className="grid min-w-0 gap-4">
      <Link to="/knowledge/docs" className="w-fit text-sm text-primary underline">
        Về danh sách tài liệu
      </Link>
      <h2 className="text-lg font-semibold break-words">{conflict.title}</h2>
      {resolved && (
        <p role="status">
          {word
            ? "Đã giải quyết xung đột. Phiên bản mới đã được lưu vào tài liệu."
            : "Đã giải quyết xung đột. Thay đổi sẽ được đồng bộ vào repo."}
        </p>
      )}
      {stale && (
        <Alert className="grid justify-items-start gap-2">
          Tài liệu đã đổi. Tải bản mới nhất trước khi chọn lại; phần sửa tay hiện tại sẽ được thay thế.
          <Button variant="outline" onClick={() => reload()}>
            Tải bản mới nhất
          </Button>
        </Alert>
      )}
      <ConflictView
        className="[&>div:first-child>span]:h-auto [&>div:first-child>span]:max-w-full [&>div:first-child>span]:whitespace-normal"
        conflict={resolved ? { ...conflict, state: "resolved" } : conflict}
        onResolve={submit}
        busy={resolve.isPending || stale}
        error={resolve.isError && !stale ? apiErrorMessage(resolve.error) : undefined}
        lang="vi"
        source={word ? "word" : "repo"}
      />
      <Dialog
        open={secret.success && attempt?.choice === "manual"}
        onOpenChange={(open) => {
          if (!open) resolve.reset();
        }}
      >
        <DialogContent>
          <DialogTitle>Xác nhận dấu hiệu bí mật</DialogTitle>
          <DialogDescription>Chỉ tiếp tục khi đã kiểm tra và xác nhận đây không phải bí mật.</DialogDescription>
          {secret.success && (
            <ul className="text-sm">
              {secret.data.findings.map((finding) => (
                <li key={`${finding.kind}:${finding.line}`}>{findingText(finding)}</li>
              ))}
            </ul>
          )}
          <DialogActions>
            <Button variant="outline" onClick={() => resolve.reset()}>
              Huỷ
            </Button>
            <Button
              disabled={resolve.isPending}
              onClick={() => {
                if (attempt?.choice === "manual") resolve.mutate({ ...attempt, acknowledgeSecrets: true });
              }}
            >
              Không phải bí mật, vẫn lưu
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
