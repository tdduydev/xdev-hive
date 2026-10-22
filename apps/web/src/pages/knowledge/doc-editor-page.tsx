import { ORPCError } from "@orpc/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  type DocResolvedLink,
  docAssetUploadOutput,
  docSecretErrorData,
  SECRET_KIND_LABELS,
  type SubmitInput,
  type WordImport,
  type WordImportFile,
  wordImportOriginalPath,
} from "@xdev-hive/contracts";
import { DocEditor, type DocEditorEnv, DocEditorProvider, type DocLinkTarget } from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { FileTextIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LoadFailure } from "@/components/ui/query-state.tsx";
import { WordImportDialog } from "@/components/word-import-dialog.tsx";
import { useWordImportSupport } from "@/lib/build-info.ts";
import { useWebDocEnv } from "@/lib/doc-editor-env.tsx";
import { When } from "@/pages/knowledge/common.tsx";
import { DocSyncDetails, useDocManage, useDocTree } from "@/pages/knowledge/doc-tree.tsx";
import { useOrg } from "@/shell/org-context.ts";

// Các ảnh cùng lượt render dùng chung một request; nội dung Markdown vẫn giữ đường dẫn repo.
export function createAssetResolver(
  resolve: (input: { docKey: string; hrefs: string[] }) => Promise<DocResolvedLink[]>,
) {
  const cache = new Map<string, Promise<DocLinkTarget | null>>();
  let pending: Array<{
    key: string;
    href: string;
    done: (value: DocLinkTarget | null) => void;
    fail: (error: unknown) => void;
  }> = [];
  const resolveLink = (key: string, href: string): Promise<DocLinkTarget | null> => {
    const id = JSON.stringify([key, href]);
    const found = cache.get(id);
    if (found) return found;
    const result = new Promise<DocLinkTarget | null>((done, fail) => {
      pending.push({ key, href, done, fail });
      if (pending.length !== 1) return;
      queueMicrotask(() => {
        const batch = pending;
        pending = [];
        const groups = Map.groupBy(batch, (item) => item.key);
        for (const [docKey, group] of groups) {
          // Hợp đồng giới hạn 1.000 link trong mỗi request.
          for (let start = 0; start < group.length; start += 1000) {
            const part = group.slice(start, start + 1000);
            void resolve({ docKey, hrefs: part.map((item) => item.href) })
              .then((links) => {
                for (const item of part) {
                  const link = links.find((link) => link.href === item.href);
                  item.done(!link || link.kind === "missing" ? null : link);
                }
              })
              .catch((error: unknown) => {
                for (const item of part) {
                  cache.delete(JSON.stringify([item.key, item.href]));
                  item.fail(error);
                }
              });
          }
        }
      });
    });
    cache.set(id, result);
    return result;
  };
  return { resolveLink, clear: () => cache.clear() };
}

/** File gốc cần cookie và tổ chức của người xem nên đi qua fetch rồi mới đưa cho trình duyệt lưu, không dùng link thẳng. */
export async function downloadWordOriginal(
  orgId: string,
  importId: string,
  file: Pick<WordImportFile, "id" | "fileName">,
) {
  const response = await fetch(wordImportOriginalPath(importId, file.id), {
    headers: { "x-hive-org": orgId },
    credentials: "same-origin",
  }).catch(() => {
    throw new Error("Không tải được file Word gốc. Kiểm tra kết nối rồi thử lại.");
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(
      typeof payload === "object" && payload && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "Không tải được file Word gốc. Hãy thử lại.",
    );
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  link.click();
  // Trình duyệt cần một nhịp để bắt đầu lưu trước khi thu hồi địa chỉ tạm.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Nhãn nguồn của tài liệu nhập từ Word: tên file, ngày, người nhập, và nút tải file gốc. */
function WordOrigin({ from }: { from: { import: WordImport; file: WordImportFile } }) {
  const { org } = useOrg();
  const download = useMutation({
    mutationFn: () => downloadWordOriginal(org.id, from.import.id, from.file),
  });
  return (
    <div className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 break-words">
        <span className="font-medium">Nhập từ Word</span>
        <span className="text-muted-foreground">
          {" · "}
          {from.file.fileName}
          {" · "}
          <When iso={from.import.createdAt} />
          {" · "}
          {from.import.createdBy.name ?? "—"}
        </span>
      </p>
      <Button variant="outline" size="sm" disabled={download.isPending} onClick={() => download.mutate()}>
        Tải file Word gốc
      </Button>
      {download.isError && (
        <Alert variant="destructive" className="basis-full">
          {download.error.message}
        </Alert>
      )}
    </div>
  );
}

export function DocEditorPage() {
  const { key } = useParams({ from: "/session/app/in-org/knowledge/docs/$key/edit" });
  const { org } = useOrg();
  return <WebDocEditor key={`${org.id}:${key}`} docKey={key} />;
}

type PendingSecret = {
  findings: { line: number; kind: keyof typeof SECRET_KIND_LABELS }[];
  accept: () => void;
  cancel: () => void;
};

function WebDocEditor({ docKey }: { docKey: string }) {
  const base = useWebDocEnv();
  const { api, org } = useOrg();
  const tree = useDocTree();
  const state = useQuery(api.docEditor.state.queryOptions({ input: { key: docKey } }));
  const canManage = useDocManage(state.data?.draft.scope);
  const [secret, setSecret] = useState<PendingSecret | null>(null);
  const [linking, setLinking] = useState(false);
  const word = useWordImportSupport();
  const homeId = tree.data?.find((item) => item.key === docKey)?.homeId;
  // Hỏi cho mọi người đọc được tài liệu: nhãn nguồn và file gốc không đòi quyền sửa. Hub chưa có `ofDoc` thì lỗi cũng
  // coi như chưa gắn, nút vẫn hiện.
  const imported = useQuery({
    ...api.wordImports.ofDoc.queryOptions({ input: { docKey } }),
    enabled: word.state === "on",
    retry: false,
  });
  const [updating, setUpdating] = useState(false);
  const canUpdate = word.state === "on" && canManage && !!homeId && !!imported.data;
  const canLink = word.state === "on" && canManage && !!homeId && (imported.isError || imported.data === null);
  const pending = useRef<PendingSecret | null>(null);
  useEffect(() => () => pending.current?.cancel(), []);
  const assets = useMemo(() => createAssetResolver((input) => api.docAssets.resolve.call(input)), [api]);
  const env: DocEditorEnv = {
    ...base,
    api: useMemo(() => {
      // Bọc lời gửi để xác nhận đúng bản nháp vừa bị chặn, giữ chu trình lưu của editor dùng chung.
      const submit = new Proxy(api.docEditor.submit, {
        get(target, property) {
          if (property !== "call") return Reflect.get(target, property);
          return async (input: SubmitInput) => {
            try {
              return await api.docEditor.submit.call(input);
            } catch (error) {
              const data = error instanceof ORPCError ? docSecretErrorData.safeParse(error.data) : null;
              if (!data?.success) throw error;
              return new Promise<Awaited<ReturnType<typeof api.docEditor.submit.call>>>((resolve, reject) => {
                const clear = () => {
                  pending.current = null;
                  setSecret(null);
                };
                const request: PendingSecret = {
                  findings: data.data.findings,
                  accept: () => {
                    clear();
                    void api.docEditor.submit.call({ ...input, acknowledgeSecrets: true }).then(resolve, reject);
                  },
                  cancel: () => {
                    clear();
                    reject(error);
                  },
                };
                pending.current = request;
                setSecret(request);
              });
            }
          };
        },
      });
      const editor = new Proxy(api.docEditor, {
        get(target, property) {
          return property === "submit" ? submit : Reflect.get(target, property);
        },
      });
      return new Proxy(api, {
        get(target, property) {
          return property === "docEditor" ? editor : Reflect.get(target, property);
        },
      });
    }, [api]),
    resolveLink: assets.resolveLink,
    uploadAsset: async (key, file) => {
      const body = new FormData();
      body.set("docKey", key);
      body.set("file", file);
      const response = await fetch("/api/v1/docs/assets", {
        method: "POST",
        headers: { "x-hive-org": org.id },
        credentials: "same-origin",
        body,
      }).catch(() => {
        throw new Error("Không tải được file lên. Kiểm tra kết nối rồi thử lại.");
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof payload === "object" && payload && "message" in payload && typeof payload.message === "string"
            ? payload.message
            : "Không tải được file lên. Hãy thử lại.";
        throw new ORPCError("BAD_REQUEST", { defined: true, message });
      }
      const parsed = docAssetUploadOutput.safeParse(payload);
      if (!parsed.success) throw new Error("Phản hồi tải file không hợp lệ.");
      assets.clear();
      return parsed.data;
    },
    errorMessage: (error) => {
      const data = error instanceof ORPCError ? docSecretErrorData.safeParse(error.data) : null;
      return data?.success
        ? `Có dấu hiệu bí mật: ${data.data.findings.map((f) => `${SECRET_KIND_LABELS[f.kind]}, dòng ${f.line}`).join("; ")}.`
        : base.errorMessage(error);
    },
  };
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1 basis-80">
          {tree.isError ? (
            <LoadFailure error={tree.error} retry={tree.refetch} />
          ) : tree.isPending ? (
            <p role="status">Đang tải trạng thái đồng bộ…</p>
          ) : (
            <DocSyncDetails item={tree.data.find((item) => item.key === docKey)} canManage={canManage} />
          )}
        </div>
        {imported.data && <WordOrigin from={imported.data} />}
        {canLink && (
          <Button variant="outline" size="sm" onClick={() => setLinking(true)}>
            Gắn với file Word
          </Button>
        )}
        {canUpdate && (
          <Button variant="outline" size="sm" onClick={() => setUpdating(true)}>
            Cập nhật từ Word
          </Button>
        )}
      </div>
      {homeId && (
        <WordImportDialog open={linking} onOpenChange={setLinking} mode="link" docKey={docKey} homeId={homeId} />
      )}
      {homeId && (
        <WordImportDialog open={updating} onOpenChange={setUpdating} mode="update" docKey={docKey} homeId={homeId} />
      )}
      <DocEditorProvider env={env}>
        <DocEditor docKey={docKey} />
      </DocEditorProvider>
      <Dialog
        open={!!secret}
        onOpenChange={(open) => {
          if (!open) secret?.cancel();
        }}
      >
        <DialogContent>
          <DialogTitle>Phát hiện dấu hiệu bí mật</DialogTitle>
          <DialogDescription>Kiểm tra loại và dòng trước khi gửi. Xác nhận sẽ được ghi vào nhật ký.</DialogDescription>
          <Alert variant="destructive">
            <ul>
              {secret?.findings.map((finding) => (
                <li key={`${finding.line}:${finding.kind}`}>
                  {SECRET_KIND_LABELS[finding.kind]} · dòng {finding.line}
                </li>
              ))}
            </ul>
          </Alert>
          <DialogActions>
            <Button variant="outline" onClick={() => secret?.cancel()}>
              Quay lại sửa
            </Button>
            {canManage && <Button onClick={() => secret?.accept()}>Vẫn lưu</Button>}
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
