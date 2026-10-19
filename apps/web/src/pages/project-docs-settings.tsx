import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type DocHome,
  type ProjectDocsSettings as DocsSettings,
  docHomeConfigureOrgInput,
  type Project,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { useId, useState } from "react";
import { FormRow, SettingsSection, SwitchRow } from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { WordImportButton } from "@/components/word-import-dialog.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useWordImportSupport } from "@/lib/build-info.ts";
import { type DocsSettingsForm, docsFormFromSettings, parseDocsForm } from "@/lib/project-settings.ts";
import { useOrg } from "@/shell/org-context.ts";

export const DOC_REPO_ACCESS_WARNING =
  "Quyền đọc trên hub và repo được cấp riêng. Người có quyền đọc repo có thể đọc mọi file trong repo đó, kể cả tài liệu bị giới hạn trên hub.";

/** Chỗ duy nhất nói cách bật nhập Word khi hub báo `wordImport: false` (FR-023). */
export const WORD_IMPORT_OFF_HINT =
  "Nhập Word đang tắt vì hub chưa tìm thấy pandoc. Quản trị cài pandoc trên máy chạy hub (hoặc đặt HIVE_PANDOC_PATH tới file pandoc) rồi khởi động lại hub. Xem docs/self-hosting.md.";

export function DocsRepoFields({
  form,
  setForm,
  disabled,
}: {
  form: DocsSettingsForm;
  setForm: (form: DocsSettingsForm) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <>
      <FormRow label="Thư mục tài liệu" htmlFor={`${id}-root`}>
        <Input
          id={`${id}-root`}
          value={form.root}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, root: e.target.value })}
        />
      </FormRow>
      <FormRow label="Thư mục ảnh và đính kèm" htmlFor={`${id}-assets`} hint="Nằm trong thư mục tài liệu.">
        <Input
          id={`${id}-assets`}
          value={form.assetsDir}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, assetsDir: e.target.value })}
        />
      </FormRow>
      <FormRow label="Ghi từ hub vào repo" htmlFor={`${id}-mode`}>
        <NativeSelect
          id={`${id}-mode`}
          value={form.repoSync}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, repoSync: e.target.value as DocsSettings["repoSync"] })}
        >
          <option value="pr">Mở PR</option>
          <option value="direct">Commit thẳng</option>
          <option value="off">Tắt đồng bộ</option>
        </NativeSelect>
      </FormRow>
      <SwitchRow
        label="Thay đổi từ repo phải qua duyệt"
        hint="Tắt thì repo đổi được cập nhật thẳng khi hub chưa sửa."
        checked={form.repoChangesNeedReview}
        disabled={disabled}
        onChange={(checked) => setForm({ ...form, repoChangesNeedReview: checked })}
      />
      <FormRow label="Mẫu lấy" htmlFor={`${id}-include`} hint="Mỗi dòng một mẫu đường dẫn.">
        <Textarea
          id={`${id}-include`}
          rows={5}
          value={form.include}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, include: e.target.value })}
        />
      </FormRow>
      <FormRow
        label="Mẫu bỏ"
        htmlFor={`${id}-exclude`}
        hint="Luôn bỏ đường dẫn do SDLC và kho skill quản lý, kể cả khi mẫu lấy khớp."
      >
        <Textarea
          id={`${id}-exclude`}
          rows={5}
          value={form.exclude}
          disabled={disabled}
          onChange={(e) => setForm({ ...form, exclude: e.target.value })}
        />
      </FormRow>
      <SwitchRow
        label="Tài liệu mật khi nhập Word"
        hint="Tài liệu nhập từ Word mặc định là tài liệu mật: không gửi đi tạo embedding. Người nhập đổi được ở hộp thoại Nhập Word."
        checked={form.wordImportConfidential}
        disabled={disabled}
        onChange={(checked) => setForm({ ...form, wordImportConfidential: checked })}
      />
      <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">{DOC_REPO_ACCESS_WARNING}</p>
    </>
  );
}

export function ProjectDocsSettings({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const home = useQuery(api.docHomes.get.queryOptions({ input: { project: project.key } }));
  const [saved, setSaved] = useState(() => docsFormFromSettings(project.settings.docs));
  const [form, setForm] = useState(saved);
  const [validation, setValidation] = useState<string>();
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const save = useMutation({
    mutationFn: (settings: DocsSettings) => api.docHomes.configureProject.call({ project: project.key, settings }),
    onSuccess: async (_, settings) => {
      const next = docsFormFromSettings(settings);
      setSaved(next);
      setForm(next);
      await Promise.all([
        cache.invalidateQueries({ queryKey: api.docHomes.key() }),
        cache.invalidateQueries({ queryKey: api.projects.key() }),
      ]);
    },
  });
  const disabled = !canEdit || save.isPending || home.isPending || home.isError;
  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <SettingsSection
        id="docs"
        title="Tài liệu"
        description="Soạn trên hub, lưu bền trong repo của dự án. Gom 60 giây từ lần lưu cuối, tối đa 10 phút."
        save={
          canEdit
            ? {
                dirty,
                saving: save.isPending,
                disabled,
                saved: save.isSuccess && !dirty,
                error: validation ?? (save.isError ? apiErrorMessage(save.error) : undefined),
                onDiscard: () => {
                  setForm(saved);
                  setValidation(undefined);
                  save.reset();
                },
                onSave: () => {
                  const result = parseDocsForm(form);
                  if (!result.success) {
                    setValidation(
                      "Cấu hình tài liệu không hợp lệ. Kiểm tra đường dẫn tương đối và tối đa 100 mẫu cho mỗi danh sách.",
                    );
                    return;
                  }
                  setValidation(undefined);
                  save.mutate(result.data);
                },
              }
            : undefined
        }
      >
        {home.isPending && <LoadingState label="Đang tải nhà tài liệu…" />}
        {home.isError && <LoadFailure error={home.error} retry={home.refetch} />}
        <p className="break-all text-sm">
          Repo dự án: {project.repo.owner}/{project.repo.name} · Nhánh:{" "}
          {home.data?.branch ?? project.repo.defaultBranch ?? "Chưa xác định"}
        </p>
        <SwitchRow
          label="Bật tài liệu gắn repo"
          checked={form.enabled}
          disabled={disabled}
          onChange={(checked) => setForm({ ...form, enabled: checked })}
        />
        <DocsRepoFields form={form} setForm={setForm} disabled={disabled} />
      </SettingsSection>
      {home.data ? (
        <DocsHomeStatus key={home.data.id} home={home.data} canEdit={canEdit} />
      ) : (
        !home.isPending &&
        !home.isError && (
          <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm">
            Chưa cấu hình nhà tài liệu. Bật tài liệu gắn repo rồi lưu cấu hình.
          </p>
        )
      )}
    </>
  );
}

const countLabels = {
  synced: "Đã đồng bộ",
  pending: "Chờ đồng bộ",
  conflict: "Xung đột",
  failed: "Lỗi đồng bộ",
  deletedInRepo: "Đã xoá trong repo",
  blockedSecret: "Bị chặn vì bí mật",
  excluded: "Đã bỏ qua",
};

export function DocsHomeStatus({ home, canEdit }: { home: DocHome; canEdit: boolean }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const status = useQuery({
    ...api.docHomes.status.queryOptions({ input: { homeId: home.id } }),
    refetchInterval: 15_000,
  });
  const [dialog, setDialog] = useState<"branch" | "adopt" | null>(null);
  const [branch, setBranch] = useState("");
  const branchId = useId();
  const [message, setMessage] = useState("");
  const current = status.data?.home ?? home;
  const wordImport = useWordImportSupport();
  const action = useMutation({
    mutationFn: async (kind: "sync" | "pause" | "resume" | "branch") => {
      const input = { homeId: home.id };
      if (kind === "sync") {
        const result = await api.docHomes.syncNow.call(input);
        return result.queued ? "Đã xếp đồng bộ." : "Chưa có thay đổi cần đồng bộ.";
      }
      if (kind === "pause") await api.docHomes.pause.call(input);
      if (kind === "resume") await api.docHomes.resume.call(input);
      if (kind === "branch") await api.docHomes.acceptBranch.call({ ...input, branch: branch.trim() });
      return kind === "pause"
        ? "Đã tạm dừng đồng bộ."
        : kind === "resume"
          ? "Đã bật lại đồng bộ."
          : "Đã chuyển sang nhánh mới.";
    },
    onMutate: () => setMessage(""),
    onSuccess: async (result) => {
      setMessage(result);
      setDialog(null);
      await cache.invalidateQueries({ queryKey: api.docHomes.key() });
    },
  });
  const branchValid = docHomeConfigureOrgInput.shape.branch.safeParse(branch.trim()).success;
  const disabled = action.isPending || status.isPending || status.isError;
  return (
    <SettingsSection
      title="Trạng thái đồng bộ"
      description={`${current.owner}/${current.name} · ${current.branch} · ${current.root || "/"}`}
    >
      {status.isPending && <LoadingState label="Đang tải trạng thái đồng bộ…" />}
      {status.isError && <LoadFailure error={status.error} retry={status.refetch} />}
      <div className="grid gap-3">
        <div>
          <Pill tone={current.status === "active" ? "ok" : current.status === "error" ? "bad" : "warn"}>
            {current.status === "active" ? "Đang hoạt động" : current.status === "paused" ? "Tạm dừng" : "Lỗi đồng bộ"}
          </Pill>
        </div>
        {current.statusReason && <Alert>{current.statusReason}</Alert>}
        {current.error && <Alert variant="destructive">{current.error}</Alert>}
        <p className="break-all text-sm">Commit cuối: {current.lastCommit ?? "Chưa có"}</p>
        {current.prUrl && (
          <a className="text-sm text-primary underline" href={current.prUrl} target="_blank" rel="noreferrer">
            PR #{current.prNumber} · Đồng bộ tài liệu
          </a>
        )}
        {status.data && (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Object.entries(status.data.counts).map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs text-muted-foreground">{countLabels[key as keyof typeof countLabels]}</dt>
                <dd className="text-lg font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {status.data?.batches
          .filter((batch) => batch.error)
          .map((batch) => (
            <Alert key={batch.id} variant="destructive">
              {batch.error}
            </Alert>
          ))}
        {message && <p role="status">{message}</p>}
        {action.isError && <Alert variant="destructive">{apiErrorMessage(action.error)}</Alert>}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={disabled || current.status === "paused" || current.mode === "off"}
              onClick={() => action.mutate("sync")}
            >
              Đồng bộ ngay
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => action.mutate(current.status === "paused" ? "resume" : "pause")}
            >
              {current.status === "paused" ? "Bật lại" : "Tạm dừng"}
            </Button>
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                action.reset();
                setDialog("branch");
              }}
            >
              Dùng nhánh mới
            </Button>
            <Button
              variant="outline"
              disabled={disabled || current.status === "paused"}
              onClick={() => setDialog("adopt")}
            >
              Đưa tài liệu hub vào repo
            </Button>
            <Link to="/knowledge/docs/import" className="self-center text-sm text-primary underline">
              Nhập từ repo
            </Link>
            <WordImportButton variant="link" homeId={home.id} targetDir={home.root} />
          </div>
        )}
        {wordImport.state === "off" && <Alert role="note">{WORD_IMPORT_OFF_HINT}</Alert>}
      </div>
      <Dialog open={dialog === "branch"} onOpenChange={(open) => !open && !action.isPending && setDialog(null)}>
        <DialogContent>
          <DialogTitle>Dùng nhánh mới</DialogTitle>
          <DialogDescription>
            Chỉ xác nhận sau khi kiểm tra nhánh mặc định mới của repo. Hub sẽ quét lại toàn bộ cây file.
          </DialogDescription>
          <label htmlFor={branchId} className="grid gap-1.5 text-sm">
            Nhánh mặc định mới
            <Input
              id={branchId}
              value={branch}
              disabled={action.isPending}
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
          {action.isError && <Alert variant="destructive">{apiErrorMessage(action.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" disabled={action.isPending} onClick={() => setDialog(null)}>
              Huỷ
            </Button>
            <Button disabled={action.isPending || !branchValid} onClick={() => action.mutate("branch")}>
              Xác nhận nhánh mới
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      {dialog === "adopt" && <AdoptDialog homeId={home.id} onClose={() => setDialog(null)} />}
    </SettingsSection>
  );
}

function AdoptDialog({ homeId, onClose }: { homeId: string; onClose: () => void }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const [keys, setKeys] = useState<string[]>([]);
  const preview = useInfiniteQuery({
    queryKey: [...api.docHomes.key(), "adopt-preview", homeId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.docHomes.adoptPreview.call({ homeId, cursor: pageParam, limit: 200 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const adopt = useMutation({
    mutationFn: () => api.docHomes.adopt.call({ homeId, keys }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: api.docHomes.key() });
      onClose();
    },
  });
  const items = preview.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && !adopt.isPending && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogTitle>Đưa tài liệu hub vào repo</DialogTitle>
        <DialogDescription>
          Chọn tài liệu sau khi kiểm tra đường dẫn và cảnh báo. Hub sẽ tạo một PR riêng, kể cả khi đang dùng chế độ
          commit thẳng.
        </DialogDescription>
        {preview.isPending && <LoadingState label="Đang xem trước đường dẫn…" />}
        {preview.isError && <LoadFailure error={preview.error} retry={preview.refetch} />}
        {!preview.isPending && !preview.isError && items.length === 0 && <p>Không có tài liệu hub cần đưa vào repo.</p>}
        <div className="grid gap-3">
          {items.map((item) => (
            <label key={item.key} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                disabled={adopt.isPending || (!keys.includes(item.key) && keys.length >= 5000)}
                checked={keys.includes(item.key)}
                onChange={(e) =>
                  setKeys((old) => (e.target.checked ? [...old, item.key] : old.filter((key) => key !== item.key)))
                }
              />
              <span className="min-w-0 break-all">
                <strong className="block">{item.key}</strong>
                {item.repoPath}
                {item.existsInRepo && <span className="block text-warning">Đường dẫn đã tồn tại trong repo.</span>}
                {item.warnings.map((warning) => (
                  <span key={warning} className="block text-warning">
                    {warning}
                  </span>
                ))}
              </span>
            </label>
          ))}
        </div>
        {preview.hasNextPage && (
          <Button
            variant="outline"
            disabled={preview.isFetchingNextPage || adopt.isPending}
            onClick={() => preview.fetchNextPage()}
          >
            Xem thêm tài liệu
          </Button>
        )}
        {adopt.isError && <Alert variant="destructive">{apiErrorMessage(adopt.error)}</Alert>}
        <DialogActions>
          <Button variant="outline" disabled={adopt.isPending} onClick={onClose}>
            Huỷ
          </Button>
          <Button disabled={adopt.isPending || keys.length === 0 || preview.isError} onClick={() => adopt.mutate()}>
            Tạo PR riêng ({keys.length})
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
