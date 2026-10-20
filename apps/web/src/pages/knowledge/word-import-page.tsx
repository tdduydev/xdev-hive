import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  WORD_IMPORT_ERRORS,
  type WordImport,
  type WordImportFile,
  type WordImportFileState,
  type WordImportGetOutput,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Pill, type PillProps } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableHeader, TableRow, Td, Th } from "@xdev-hive/ui/table";
import { FileTextIcon, PencilIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { FilterChips } from "@/components/ui/filter-chips.tsx";
import { EmptyState, LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { importErrorMessage, WordImportFilePanel, WordLinkReview } from "@/pages/knowledge/word-import-file-panel.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const POLL_MS = 2000;
const ACTIVE_FILE: readonly WordImportFileState[] = ["queued", "converting"];
const ACTIVE_IMPORT: readonly WordImport["state"][] = ["uploading", "converting", "committing"];
const OPEN_IMPORT: readonly WordImport["state"][] = ["uploading", "converting", "ready"];

/** Còn việc hub đang làm thì hỏi lại; xong hết thì dừng để trang không gọi hub vô ích. */
export function stillWorking(data: WordImportGetOutput | undefined): boolean {
  if (!data) return false;
  return ACTIVE_IMPORT.includes(data.import.state) || data.files.some((file) => ACTIVE_FILE.includes(file.state));
}

const STATE_LABEL: Record<WordImportFileState, { text: string; tone: NonNullable<PillProps["tone"]> }> = {
  queued: { text: "Chờ chuyển", tone: "neutral" },
  converting: { text: "Đang chuyển", tone: "neutral" },
  ready: { text: "Sẵn sàng", tone: "ok" },
  skipped: { text: "Bỏ qua", tone: "neutral" },
  blocked_secret: { text: "Có bí mật", tone: "bad" },
  failed: { text: "Lỗi", tone: "bad" },
  proposed: { text: "Đã gửi duyệt", tone: "sel" },
  cancelled: { text: "Đã huỷ", tone: "neutral" },
  done: { text: "Đã tạo", tone: "ok" },
};

type Filter = "all" | "working" | "ready" | "secret" | "failed" | "skipped" | "finished";
const FILTERS: readonly { key: Filter; label: string; states: readonly WordImportFileState[] | null }[] = [
  { key: "all", label: "Tất cả", states: null },
  { key: "working", label: "Đang chuyển", states: ACTIVE_FILE },
  { key: "ready", label: "Sẵn sàng", states: ["ready"] },
  { key: "secret", label: "Có bí mật", states: ["blocked_secret"] },
  { key: "failed", label: "Lỗi", states: ["failed"] },
  { key: "skipped", label: "Bỏ qua", states: ["skipped", "cancelled"] },
  { key: "finished", label: "Đã tạo", states: ["done", "proposed"] },
];

export function filterFiles(files: readonly WordImportFile[], filter: Filter): WordImportFile[] {
  const states = FILTERS.find((item) => item.key === filter)?.states;
  return states ? files.filter((file) => states.includes(file.state)) : [...files];
}

/** Đường dẫn trong lượt phải là `.md`; kiểm trước để khỏi chờ hub trả lỗi cho lỗi gõ nhầm. */
export function pathProblem(value: string): string | null {
  const path = value.trim();
  if (!path) return "Nhập đường dẫn tài liệu.";
  if (!/\.md$/i.test(path)) return "Đường dẫn tài liệu phải kết thúc bằng .md.";
  return null;
}

export function WordImportPage() {
  const { id } = useParams({ from: "/session/app/in-org/knowledge/docs/word-imports/$id" });
  const { api } = useOrg();
  const query = useQuery({
    ...api.wordImports.get.queryOptions({ input: { importId: id } }),
    refetchInterval: (q) => (stillWorking(q.state.data) ? POLL_MS : false),
  });
  const data = query.data;
  return (
    <>
      <PageHeader
        crumb={<Link to="/knowledge/docs/word-imports">← Các lượt nhập Word</Link>}
        title={data?.import.mode === "link" ? "Gắn tài liệu với file Word" : "Lượt nhập Word"}
        description={
          data?.import.mode === "link"
            ? "So nội dung tài liệu với file Word trước khi gắn."
            : "Xem lại các file đã tải lên trước khi tạo tài liệu."
        }
        width="wide"
      />
      <PageBody width="wide">
        {query.isPending && <LoadingState label="Đang tải lượt nhập…" />}
        {query.isError && <LoadFailure error={query.error} retry={query.refetch} />}
        {data && (data.import.mode === "link" ? <LinkImport data={data} /> : <FileImport data={data} />)}
      </PageBody>
    </>
  );
}

function useCancel(importId: string) {
  const { api } = useOrg();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: () => api.wordImports.cancel.call({ importId }),
    onSuccess: () => cache.invalidateQueries({ queryKey: api.wordImports.key() }),
  });
}

function LinkImport({ data }: { data: WordImportGetOutput }) {
  const cancel = useCancel(data.import.id);
  const file = data.files[0];
  const docKey = data.import.docKey;
  const cancelled = data.import.state === "cancelled";
  return (
    <div className="grid min-w-0 gap-4">
      {file && (
        <p className="text-sm text-muted-foreground">
          File Word: <span className="font-medium text-foreground">{file.fileName}</span>
        </p>
      )}
      {cancel.isError && <Alert variant="destructive">{importErrorMessage(cancel.error)}</Alert>}
      {cancelled && <p role="status">Đã huỷ. Tài liệu giữ nguyên, chưa gắn với file Word.</p>}
      {file && !cancelled && (
        <WordLinkReview
          file={file}
          access={data.access}
          cancelling={cancel.isPending}
          onCancel={() => cancel.mutate()}
        />
      )}
      {docKey && (
        <Link
          to="/knowledge/docs/$key/edit"
          params={{ key: docKey }}
          className="w-fit text-sm text-primary underline underline-offset-2"
        >
          Mở tài liệu
        </Link>
      )}
    </div>
  );
}

function FileImport({ data }: { data: WordImportGetOutput }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const cancel = useCancel(data.import.id);
  const commit = useMutation({
    mutationFn: () => api.wordImports.commit.call({ importId: data.import.id }),
    onSuccess: () => cache.invalidateQueries({ queryKey: api.wordImports.key() }),
  });
  const toggle = useMutation({
    mutationFn: (input: { fileId: string; excluded: boolean }) => api.wordImports.update.call(input),
    onSuccess: () => cache.invalidateQueries({ queryKey: api.wordImports.key() }),
  });
  const open = OPEN_IMPORT.includes(data.import.state);
  const files = filterFiles(data.files, filter);
  const chosen = data.files.filter((file) => file.state === "ready" && !file.excluded);
  const taken = chosen.filter((file) => file.exists);
  const proposing = data.access === "propose";
  const opened = data.files.find((file) => file.id === openId) ?? null;
  const finished = data.files.some((file) => ["done", "proposed", "failed"].includes(file.state));
  const commitLabel = `${proposing ? "Gửi duyệt" : "Tạo"} ${chosen.length} tài liệu`;
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChips
          label="Lọc theo trạng thái"
          value={filter}
          onChange={setFilter}
          chips={FILTERS.filter(
            (item) => item.key === "all" || filterFiles(data.files, item.key).length > 0 || item.key === filter,
          ).map((item) => ({ key: item.key, label: item.label, count: filterFiles(data.files, item.key).length }))}
        />
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {open && (
            <Button variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Huỷ lượt nhập
            </Button>
          )}
          {open && (
            <Button
              disabled={chosen.length === 0 || taken.length > 0 || data.import.state !== "ready" || commit.isPending}
              onClick={() => commit.mutate()}
            >
              {commitLabel}
            </Button>
          )}
        </div>
      </div>
      {data.import.state === "converting" && <LoadingState label="Hub đang chuyển các file Word…" />}
      {taken.length > 0 && (
        <Alert>{taken.length} file có đường dẫn đã có tài liệu. Đổi tên các file đó hoặc bỏ chọn trước khi tạo.</Alert>
      )}
      {proposing && open && (
        <Alert>Bạn chưa có quyền quản lý thư mục này nên tài liệu sẽ được gửi duyệt thay vì tạo ngay.</Alert>
      )}
      {commit.isError && <Alert variant="destructive">{importErrorMessage(commit.error)}</Alert>}
      {cancel.isError && <Alert variant="destructive">{importErrorMessage(cancel.error)}</Alert>}
      {toggle.isError && <Alert variant="destructive">{importErrorMessage(toggle.error)}</Alert>}
      {files.length === 0 ? (
        <EmptyState
          icon={FileTextIcon}
          title="Không có file nào"
          description={data.files.length === 0 ? "Lượt nhập chưa có file nào." : "Không có file nào ở trạng thái này."}
          compact
        />
      ) : (
        <div className="min-w-0 rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <Th className="w-10">
                  <span className="sr-only">Chọn</span>
                </Th>
                <Th>File gốc</Th>
                <Th>Đường dẫn tài liệu</Th>
                <Th>Phiên bản</Th>
                <Th>Trạng thái</Th>
                <Th className="text-right">Cảnh báo</Th>
                <Th>
                  <span className="sr-only">Thao tác</span>
                </Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  editable={open && ["ready", "blocked_secret", "failed", "skipped"].includes(file.state)}
                  renaming={renaming === file.id}
                  onRename={(on) => setRenaming(on ? file.id : null)}
                  onToggle={(excluded) => toggle.mutate({ fileId: file.id, excluded })}
                  onOpen={() => setOpenId(file.id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {(finished || !open) && <Report data={data} />}
      <Sheet open={opened !== null} onOpenChange={(next) => !next && setOpenId(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto data-[side=right]:sm:max-w-2xl">
          {opened && (
            <>
              <SheetHeader>
                <SheetTitle className="break-words">{opened.fileName}</SheetTitle>
                <SheetDescription className="break-words">
                  {opened.path ?? "Chưa có đường dẫn đề xuất"}
                </SheetDescription>
              </SheetHeader>
              <div className="min-w-0 px-4 pb-4">
                <WordImportFilePanel file={opened} access={data.access} canEdit={open} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function FileRow({
  file,
  editable,
  renaming,
  onRename,
  onToggle,
  onOpen,
}: {
  file: WordImportFile;
  editable: boolean;
  renaming: boolean;
  onRename: (on: boolean) => void;
  onToggle: (excluded: boolean) => void;
  onOpen: () => void;
}) {
  const label = STATE_LABEL[file.state];
  return (
    <TableRow>
      <Td>
        {file.state === "ready" && (
          <Checkbox
            aria-label={`Chọn ${file.fileName}`}
            checked={!file.excluded}
            disabled={!editable}
            onCheckedChange={(checked) => onToggle(!checked)}
          />
        )}
      </Td>
      <Td className="max-w-64 min-w-40 break-words">{file.fileName}</Td>
      <Td className="min-w-56">
        {renaming ? (
          <PathEditor file={file} onClose={() => onRename(false)} />
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 font-mono text-xs break-all">{file.path ?? "—"}</span>
            {file.exists && <Pill tone="warn">Đã có</Pill>}
            {editable && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Đổi tên ${file.fileName}`}
                onClick={() => onRename(true)}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
        {file.exists && !renaming && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {editable && (
              <Button variant="outline" size="sm" onClick={() => onRename(true)}>
                Đổi tên
              </Button>
            )}
            {/* Cập nhật từ Word là việc của T018; nút giữ chỗ để người dùng thấy lối đi thứ hai. */}
            <Button variant="outline" size="sm" disabled title="Chưa có ở bản này">
              Cập nhật từ Word
            </Button>
          </div>
        )}
      </Td>
      <Td className="font-mono text-xs tabular-nums">{file.versionLabel ?? "—"}</Td>
      <Td>
        <Pill tone={label.tone} dot>
          {label.text}
        </Pill>
        {file.error && (
          <p className="mt-1 max-w-64 text-xs text-destructive">{WORD_IMPORT_ERRORS[file.error.code].message}</p>
        )}
      </Td>
      <Td className="text-right tabular-nums">{file.warnings.length}</Td>
      <Td className="text-right">
        <Button variant="outline" size="sm" onClick={onOpen} aria-label={`Xem ${file.fileName}`}>
          Xem
        </Button>
      </Td>
    </TableRow>
  );
}

function PathEditor({ file, onClose }: { file: WordImportFile; onClose: () => void }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const [value, setValue] = useState(file.path ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (path: string) => api.wordImports.update.call({ fileId: file.id, path }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: api.wordImports.key() });
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = pathProblem(value);
    setProblem(found);
    if (!found) save.mutate(value.trim());
  };
  const shown = problem ?? (save.isError ? importErrorMessage(save.error) : null);
  return (
    <form onSubmit={submit} className="grid gap-1.5">
      <Input
        autoFocus
        name="path"
        autoComplete="off"
        spellCheck={false}
        aria-label={`Đường dẫn tài liệu của ${file.fileName}`}
        aria-invalid={shown !== null}
        value={value}
        onValueChange={setValue}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
        className="font-mono text-xs"
      />
      {shown && <p className="text-xs text-destructive">{shown}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          Lưu
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Bỏ
        </Button>
      </div>
    </form>
  );
}

/** Kết quả sau khi tạo: link tới từng tài liệu, và lý do bằng tiếng Việt cho file không tạo được. */
function Report({ data }: { data: WordImportGetOutput }) {
  const made = data.files.filter((file) => file.state === "done");
  const proposed = data.files.filter((file) => file.state === "proposed");
  const failed = data.files.filter((file) => file.state === "failed");
  if (made.length + proposed.length + failed.length === 0) return null;
  return (
    <section aria-label="Kết quả" className="grid gap-3 rounded-lg border border-border p-4">
      <h2 className="text-base font-semibold">Kết quả</h2>
      {made.length > 0 && (
        <div className="grid gap-1">
          <p className="text-sm">Đã tạo {made.length} tài liệu:</p>
          <ul className="grid gap-1 text-sm">
            {made.map((file) => (
              <li key={file.id} className="min-w-0 break-words">
                {file.key ? (
                  <Link
                    to="/knowledge/docs/$key/edit"
                    params={{ key: file.key }}
                    className="text-primary underline underline-offset-2"
                  >
                    {file.title ?? file.path ?? file.fileName}
                  </Link>
                ) : (
                  (file.title ?? file.fileName)
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposed.length > 0 && (
        <div className="grid gap-1">
          <p className="text-sm">Đã gửi duyệt {proposed.length} tài liệu:</p>
          <ul className="list-disc pl-5 text-sm">
            {proposed.map((file) => (
              <li key={file.id} className="break-words">
                {file.title ?? file.path ?? file.fileName}
              </li>
            ))}
          </ul>
        </div>
      )}
      {failed.length > 0 && (
        <div className="grid gap-1">
          <p className="text-sm">Không tạo được {failed.length} file:</p>
          <ul className="grid gap-1 text-sm">
            {failed.map((file) => (
              <li key={file.id} className="break-words">
                <span className="font-medium">{file.fileName}</span>:{" "}
                {file.error ? WORD_IMPORT_ERRORS[file.error.code].message : "Không rõ lý do."}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
