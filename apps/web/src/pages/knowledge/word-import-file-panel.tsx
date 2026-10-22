import { ORPCError } from "@orpc/client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  SECRET_KIND_LABELS,
  WORD_IMPORT_ERRORS,
  WORD_IMPORT_WARNINGS,
  type WordImportFile,
  type WordImportFileDetail,
  type WordImportGetOutput,
  wordImportErrorCode,
} from "@xdev-hive/contracts";
import { conflictRows } from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Markdown } from "@xdev-hive/ui/markdown";
import { useMemo } from "react";
import { SwitchRow } from "@/components/page/settings.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useOrg } from "@/shell/org-context.ts";

/** Câu của hợp đồng theo `data.code`, để web và desktop nói giống nhau dù hub đổi câu (FR-022). */
export function importErrorMessage(error: unknown): string {
  const code = error instanceof ORPCError && error.data ? wordImportErrorCode.safeParse(error.data.code) : null;
  return code?.success ? WORD_IMPORT_ERRORS[code.data].message : apiErrorMessage(error);
}

export function warningText(warning: WordImportFile["warnings"][number]): string {
  const base = WORD_IMPORT_WARNINGS[warning.code];
  const times = warning.count > 1 ? ` (${warning.count} chỗ)` : "";
  return `${base}${times}${warning.detail ? ` ${warning.detail}` : ""}`;
}

export function findingLine(finding: WordImportFile["findings"][number]): string {
  return `dòng ${finding.line} (${SECRET_KIND_LABELS[finding.kind]})`;
}

type WordImportAccess = WordImportGetOutput["access"];

const BASENAME = /[^/]+$/;
/**
 * Ảnh và đính kèm trong Markdown xem trước trỏ tới tên đã băm (`<12 hex>.png`); route của hub phục vụ theo tên đó. Viewer
 * Markdown chỉ tải ảnh `http(s)`, và `<img>` không gửi được header tổ chức nên đưa tổ chức vào `org` như `docAssets`.
 * `<br>` trong ô bảng là HTML thô, viewer hiện nguyên chữ nên đổi thành ký hiệu xuống dòng.
 */
export function previewMarkdown(
  markdown: string,
  images: WordImportFileDetail["images"],
  origin: string,
  orgId: string,
): string {
  const byName = new Map(images.map((image) => [image.name, image.url]));
  const linked = markdown.replace(
    /(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
    (whole, bang, text, href, title) => {
      const name = BASENAME.exec(String(href).split(/[?#]/)[0] ?? "")?.[0];
      const url = name ? byName.get(decodeURIComponent(name)) : undefined;
      if (!url) return whole;
      const sep = url.includes("?") ? "&" : "?";
      return `${bang}[${text}](${origin}${url}${sep}org=${encodeURIComponent(orgId)}${title})`;
    },
  );
  return linked.replace(/<br\s*\/?>/gi, " ⏎ ");
}

function useFileDetail(file: WordImportFile) {
  const { api } = useOrg();
  const options = api.wordImports.file.queryOptions({ input: { fileId: file.id } });
  // `updatedAt` đổi khi hub chuyển xong lại (đổi "Giữ phần trước tiêu đề đầu tiên"), nên đưa vào khoá để tải lại.
  return useQuery({
    ...options,
    queryKey: [...options.queryKey, file.updatedAt],
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}

function WarningList({ file }: { file: WordImportFile }) {
  if (file.warnings.length === 0) return null;
  return (
    <section aria-label="Cảnh báo" className="grid gap-2">
      <h3 className="text-sm font-medium">Cảnh báo ({file.warnings.length})</h3>
      <ul className="grid gap-2">
        {file.warnings.map((warning) => (
          <li key={warning.code}>
            <Alert role="note">{warningText(warning)}</Alert>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Ngăn bên của một file: cảnh báo, bí mật, công tắc "Giữ phần trước tiêu đề đầu tiên" và nội dung chuyển. */
export function WordImportFilePanel({
  file,
  canEdit,
  access,
}: {
  file: WordImportFile;
  canEdit: boolean;
  access: WordImportAccess;
}) {
  const { api, org } = useOrg();
  const cache = useQueryClient();
  const detail = useFileDetail(file);
  // Chỉ người `manage` được bỏ qua cảnh báo bí mật; lượt này nhập đúng file đó, không kéo theo file khác (FR-014).
  const acknowledge = useMutation({
    mutationFn: () =>
      api.wordImports.commit.call({ importId: file.importId, fileIds: [file.id], acknowledgeSecrets: true }),
    onSuccess: () => cache.invalidateQueries({ queryKey: api.wordImports.key() }),
  });
  const update = useMutation({
    mutationFn: (keepFront: boolean) => api.wordImports.update.call({ fileId: file.id, keepFront }),
    onSuccess: () => cache.invalidateQueries({ queryKey: api.wordImports.key() }),
  });
  const converting = file.state === "queued" || file.state === "converting";
  const markdown = detail.data?.markdown;
  const preview = useMemo(
    () =>
      markdown == null ? null : previewMarkdown(markdown, detail.data?.images ?? [], window.location.origin, org.id),
    [markdown, detail.data?.images, org.id],
  );
  return (
    <div className="grid min-w-0 gap-4">
      {file.error && <Alert variant="destructive">{WORD_IMPORT_ERRORS[file.error.code].message}</Alert>}
      {file.findings.length > 0 && (
        <Alert variant="destructive">
          <p className="font-medium">Có dấu hiệu bí mật. Chỉ hiện loại và dòng, không hiện giá trị.</p>
          <ul className="mt-1 list-disc pl-5">
            {file.findings.map((finding) => (
              <li key={`${finding.line}:${finding.kind}`}>{findingLine(finding)}</li>
            ))}
          </ul>
        </Alert>
      )}
      {file.state === "blocked_secret" &&
        (access === "manage" ? (
          <div className="grid justify-items-start gap-2">
            <Button variant="outline" disabled={acknowledge.isPending} onClick={() => acknowledge.mutate()}>
              Không phải bí mật, vẫn nhập
            </Button>
            {acknowledge.isError && <Alert variant="destructive">{importErrorMessage(acknowledge.error)}</Alert>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Chỉ người có quyền quản lý tài liệu mới nhập tiếp được file có dấu hiệu bí mật.
          </p>
        ))}
      <WarningList file={file} />
      {canEdit && (
        <SwitchRow
          label="Giữ phần trước tiêu đề đầu tiên"
          hint="Mặc định bỏ trang bìa và mục lục. Bật để giữ lại; hub chuyển lại file này."
          checked={file.keepFront}
          disabled={update.isPending || converting}
          onChange={(value) => update.mutate(value)}
        />
      )}
      {update.isError && <Alert variant="destructive">{importErrorMessage(update.error)}</Alert>}
      <section aria-label="Xem trước" className="grid min-w-0 gap-2">
        <h3 className="text-sm font-medium">Xem trước (chỉ đọc)</h3>
        {converting && <LoadingState label="Đang chuyển file Word…" />}
        {!converting && detail.isPending && <LoadingState label="Đang tải nội dung…" />}
        {detail.isError && <LoadFailure error={detail.error} retry={detail.refetch} />}
        {preview !== null && !converting && (
          <div className="min-w-0 overflow-x-auto rounded-lg border border-border p-3">
            <Markdown content={preview} lang="vi" />
          </div>
        )}
        {markdown === null && !converting && !file.error && !detail.isPending && (
          <p className="text-sm text-muted-foreground">File này chưa có nội dung chuyển.</p>
        )}
      </section>
    </div>
  );
}

/** Hai bên của lần gắn: nội dung hiện tại và bản chuyển từ Word, chỉ các khối khác nhau. */
export function linkDiffRows(current: string, converted: string) {
  const rows = conflictRows(current, current, converted);
  const changed = rows.filter((row) => row.kind !== "same");
  return { changed, same: rows.length - changed.length };
}

function LinkDiff({ current, converted }: { current: string; converted: string }) {
  const { changed, same } = useMemo(() => linkDiffRows(current, converted), [current, converted]);
  if (changed.length === 0) return <Alert>Hai bản giống nhau từng khối.</Alert>;
  return (
    <section aria-label="Khác biệt từng khối" className="grid min-w-0 gap-2">
      <p className="text-sm text-muted-foreground">
        {changed.length} chỗ khác nhau, {same} khối giống nhau (không hiện).
      </p>
      <div className="min-w-0 rounded-lg border border-border">
        <div className="grid grid-cols-2 border-b border-border text-sm font-medium">
          <div className="px-3 py-2">Tài liệu hiện tại</div>
          <div className="border-l border-border px-3 py-2">Bản chuyển từ Word</div>
        </div>
        {changed.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: danh sách chỉ đọc dựng một lần từ hai bản chữ, thứ tự cố định.
          <div key={i} className="grid grid-cols-2 border-b border-border last:border-b-0">
            {[row.base, row.repo].map((blocks, side) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: hai cột cố định.
                key={side}
                className={`min-w-0 px-3 py-2 ${side === 1 ? "border-l border-border bg-warning-soft" : ""}`}
              >
                {blocks.length ? (
                  <pre className="font-mono text-xs/5 break-words whitespace-pre-wrap">{blocks.join("\n\n")}</pre>
                ) : (
                  <span className="text-xs italic text-muted-foreground">(không có)</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Lượt `link` (FR-028): một file. Khớp nội dung thì hub đã gắn xong; không khớp thì hiện khác biệt và chờ người gắn
 * bấm "Lấy bản chuyển làm gốc" hoặc huỷ.
 */
export function WordLinkReview({
  file,
  access,
  onCancel,
  cancelling,
}: {
  file: WordImportFile;
  access: WordImportAccess;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const detail = useFileDetail(file);
  const confirm = useMutation({
    mutationFn: () => api.wordImports.confirmLink.call({ fileId: file.id }),
    onSuccess: () => cache.invalidateQueries({ queryKey: api.wordImports.key() }),
  });
  const waiting = file.state === "queued" || file.state === "converting";
  const pending = file.state === "ready";
  return (
    <div className="grid min-w-0 gap-4">
      {waiting && <LoadingState label="Đang chuyển file Word để so với tài liệu…" />}
      {file.error && <Alert variant="destructive">{WORD_IMPORT_ERRORS[file.error.code].message}</Alert>}
      {file.state === "done" && (
        <p role="status">
          {file.linkMatches === false
            ? "Đã lấy bản chuyển làm gốc. Lần cập nhật từ Word sau sẽ so với bản này."
            : "Nội dung khớp với file Word. Tài liệu đã được gắn, không tạo phiên bản mới."}
        </p>
      )}
      <WarningList file={file} />
      {pending && file.linkMatches === false && (
        <>
          <Alert>
            Nội dung tài liệu và file Word khác nhau. Xem từng khối bên dưới rồi chọn: lấy bản chuyển làm gốc để lần cập
            nhật sau so với nó, hoặc huỷ để giữ nguyên.
          </Alert>
          {detail.isError && <LoadFailure error={detail.error} retry={detail.refetch} />}
          {detail.data?.current && detail.data.markdown != null ? (
            <LinkDiff current={detail.data.current.content} converted={detail.data.markdown} />
          ) : (
            !detail.isError && <LoadingState label="Đang tải hai bản để so…" />
          )}
          {confirm.isError && <Alert variant="destructive">{importErrorMessage(confirm.error)}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={confirm.isPending || cancelling || access !== "manage"} onClick={() => confirm.mutate()}>
              Lấy bản chuyển làm gốc
            </Button>
            <Button variant="outline" disabled={confirm.isPending || cancelling} onClick={onCancel}>
              Huỷ
            </Button>
          </div>
          {access !== "manage" && (
            <p className="text-xs text-muted-foreground">
              Chỉ người có quyền quản lý tài liệu mới lấy bản chuyển làm gốc.
            </p>
          )}
        </>
      )}
      {pending && file.linkMatches !== false && <LoadingState label="Đang gắn tài liệu…" />}
    </div>
  );
}

export type UpdateOutcome = "pending" | "unchanged" | "clean" | "overlap" | "updated" | "conflict";

/**
 * Kết quả lượt `update` suy từ file (hub ghi `linkMatches` khi xem trước và khi tạo, plan.md mục 8): `skipped` là cùng
 * SHA-256 với lần trước; `ready` xem trước hợp sạch hay chồng nhau; `done` có phiên bản mới, hoặc đã ghi xung đột (không
 * có phiên bản), hoặc không đổi chữ nào.
 */
export function updateOutcome(file: WordImportFile): UpdateOutcome {
  if (file.state === "skipped") return "unchanged";
  if (file.state === "ready") return file.linkMatches === null ? "pending" : file.linkMatches ? "clean" : "overlap";
  if (file.state === "done") {
    if (file.docVersion !== null) return "updated";
    return file.linkMatches === false ? "conflict" : "unchanged";
  }
  return "pending";
}

function SavedConflict({ file, homeId }: { file: WordImportFile; homeId: string }) {
  const { api } = useOrg();
  const open = useQuery(api.docConflicts.list.queryOptions({ input: { homeId, state: "open", limit: 200 } }));
  const found = open.data?.items.find((item) => item.docId === file.docId);
  const detail = useQuery({
    ...api.docConflicts.get.queryOptions({ input: { id: found?.id ?? "" } }),
    enabled: !!found,
  });
  const count = detail.data?.merge.conflicts;
  return (
    <Alert role="status" className="grid justify-items-start gap-2">
      <p>
        {count === undefined ? "Có chỗ chồng nhau" : `${count} chỗ chồng nhau`} giữa tài liệu và bản Word mới. Bản Word
        này đã thành gốc cho lần cập nhật sau; chọn cách giải quyết ở màn xung đột.
      </p>
      {open.isError && <p className="text-sm text-destructive">{importErrorMessage(open.error)}</p>}
      {found && (
        <Link
          to="/knowledge/docs/conflicts/$id"
          params={{ id: found.id }}
          className="text-sm text-primary underline underline-offset-2"
        >
          Giải quyết xung đột
        </Link>
      )}
    </Alert>
  );
}

function OverlapPreview({ file }: { file: WordImportFile }) {
  const detail = useFileDetail(file);
  return (
    <>
      <Alert>
        Có chỗ chồng nhau giữa tài liệu hiện tại và bản Word mới. Bấm "Cập nhật" để ghi thành xung đột rồi giải quyết ở
        màn xung đột; tài liệu chưa đổi.
      </Alert>
      {detail.isError && <LoadFailure error={detail.error} retry={detail.refetch} />}
      {detail.data?.current && detail.data.markdown != null ? (
        <LinkDiff current={detail.data.current.content} converted={detail.data.markdown} />
      ) : (
        !detail.isError && <LoadingState label="Đang tải hai bản để so…" />
      )}
    </>
  );
}

/** Lượt `update` (FR-024, FR-025): một file; hiện kết quả hợp ba bên, buộc người cập nhật nhìn trước khi áp dụng. */
export function WordUpdateReview({ file, homeId }: { file: WordImportFile; homeId: string }) {
  const outcome = updateOutcome(file);
  const waiting = file.state === "queued" || file.state === "converting";
  return (
    <div className="grid min-w-0 gap-4">
      {waiting && <LoadingState label="Đang chuyển file Word để so với tài liệu…" />}
      {file.error && <Alert variant="destructive">{WORD_IMPORT_ERRORS[file.error.code].message}</Alert>}
      {file.state === "blocked_secret" && (
        <Alert variant="destructive">
          Có dấu hiệu bí mật: {file.findings.map(findingLine).join("; ")}. Chỉ hiện loại và dòng, không hiện giá trị.
        </Alert>
      )}
      <WarningList file={file} />
      {file.state === "ready" && outcome === "pending" && (
        <Alert>Chưa so được: tài liệu chưa nhập hay gắn với file Word nào. Gắn tài liệu với file Word trước.</Alert>
      )}
      {outcome === "unchanged" && <p role="status">Không có gì thay đổi so với lần nhập Word trước.</p>}
      {outcome === "clean" && (
        <Alert role="status">Hợp sạch. Bản Word mới hợp được với tài liệu hiện tại, không có chỗ chồng nhau.</Alert>
      )}
      {outcome === "overlap" && <OverlapPreview file={file} />}
      {outcome === "updated" && <p role="status">Hợp sạch. Đã lưu phiên bản {file.docVersion} của tài liệu.</p>}
      {outcome === "conflict" && <SavedConflict file={file} homeId={homeId} />}
    </div>
  );
}
