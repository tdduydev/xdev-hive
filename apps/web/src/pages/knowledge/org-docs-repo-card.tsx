import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type DocHome, docHomeConfigureOrgInput, projectDocsSettings } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { useId, useState } from "react";
import { FormRow, SettingsSection } from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { docsFormFromSettings, parseDocsForm } from "@/lib/project-settings.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { DocsHomeStatus, DocsRepoFields } from "@/pages/project-docs-settings.tsx";
import { useOrg } from "@/shell/org-context.ts";

export function OrgDocsRepoCard() {
  const { api, org } = useOrg();
  const home = useQuery(api.docHomes.get.queryOptions({ input: {} }));
  return (
    <div className="grid min-w-0 gap-4">
      {home.isPending ? (
        <SettingsSection title="Kho tài liệu tổ chức">
          <LoadingState label="Đang tải kho tài liệu tổ chức…" />
        </SettingsSection>
      ) : home.isError ? (
        <SettingsSection title="Kho tài liệu tổ chức">
          <LoadFailure error={home.error} retry={home.refetch} />
        </SettingsSection>
      ) : (
        <RepoForm key={`form:${home.data?.id ?? "new"}`} home={home.data ?? null} canEdit={isOrgAdmin(org.role)} />
      )}
      {home.data && <DocsHomeStatus key={`status:${home.data.id}`} home={home.data} canEdit={isOrgAdmin(org.role)} />}
    </div>
  );
}

function RepoForm({ home, canEdit }: { home: DocHome | null; canEdit: boolean }) {
  const { api } = useOrg();
  const cache = useQueryClient();
  const id = useId();
  const connections = useQuery({ ...api.scmConnections.list.queryOptions(), enabled: canEdit });
  const [form, setForm] = useState(() => formFromHome(home));
  const [saved, setSaved] = useState(form);
  const [validation, setValidation] = useState<string>();
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const save = useMutation({
    mutationFn: (input: typeof docHomeConfigureOrgInput._output) => api.docHomes.configureOrg.call(input),
    onSuccess: async (next) => {
      const canonical = formFromHome(next);
      setForm(canonical);
      setSaved(canonical);
      await cache.invalidateQueries({ queryKey: api.docHomes.key() });
    },
  });
  const disabled = !canEdit || save.isPending;
  const chosen = form.connectionId || connections.data?.[0]?.id || "";
  function submit() {
    // Nhà tổ chức được phép dùng gốc repo, còn nhà dự án luôn cần một thư mục.
    const docs = parseDocsForm({ ...form.docs, root: form.docs.root.trim() || "docs/" });
    if (!docs.success) {
      setValidation("Kiểm tra đường dẫn tương đối và tối đa 100 mẫu cho mỗi danh sách.");
      return;
    }
    const input = docHomeConfigureOrgInput.safeParse({
      connectionId: chosen,
      owner: form.owner.trim(),
      name: form.name.trim(),
      branch: form.branch.trim() || undefined,
      create: form.create,
      root: form.docs.root.trim(),
      assetsDir: docs.data.assetsDir,
      mode: docs.data.repoSync,
      include: docs.data.include,
      exclude: docs.data.exclude,
      repoChangesNeedReview: docs.data.repoChangesNeedReview,
      wordImportConfidential: docs.data.wordImportConfidential,
    });
    if (!input.success) {
      setValidation("Kết nối, chủ sở hữu, tên repo hoặc nhánh không hợp lệ. Kiểm tra lại các ô.");
      return;
    }
    setValidation(undefined);
    save.mutate(input.data);
  }
  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <SettingsSection
        title="Kho tài liệu tổ chức"
        description="Một repo riêng cho tổ chức và các đội. Chỉ quản trị tổ chức được thay đổi."
        save={
          canEdit
            ? {
                dirty: dirty || !home,
                saving: save.isPending,
                disabled: connections.isPending || connections.isError || !chosen,
                saved: save.isSuccess && !dirty,
                error: validation ?? (save.isError ? apiErrorMessage(save.error) : undefined),
                onSave: submit,
                onDiscard: () => {
                  setForm(saved);
                  setValidation(undefined);
                  save.reset();
                },
              }
            : undefined
        }
      >
        {!canEdit && <Alert role="note">Bạn đang xem ở chế độ chỉ đọc.</Alert>}
        {!home && <Alert role="note">Chưa có kho tài liệu tổ chức. Chọn repo có sẵn hoặc tạo repo riêng tư mới.</Alert>}
        {connections.isError && <LoadFailure error={connections.error} retry={connections.refetch} />}
        {canEdit && connections.isPending && <LoadingState label="Đang tải kết nối Git…" />}
        {canEdit && connections.data?.length === 0 && (
          <Alert role="note">Chưa có kết nối Git. Quản trị tổ chức cần thêm kết nối trước.</Alert>
        )}
        <FormRow label="Kết nối Git" htmlFor={`${id}-connection`}>
          <NativeSelect
            id={`${id}-connection`}
            value={chosen}
            disabled={disabled || connections.isPending || connections.isError}
            onChange={(e) => {
              const connection = connections.data?.find((item) => item.id === e.target.value);
              setForm({ ...form, connectionId: e.target.value, owner: connection?.defaultOwner ?? form.owner });
            }}
          >
            {!canEdit && home ? (
              <option value={home.connectionId}>Kết nối của kho tài liệu</option>
            ) : (
              connections.data?.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name} ({connection.kind})
                </option>
              ))
            )}
          </NativeSelect>
        </FormRow>
        <FormRow label="Cách chọn repo" htmlFor={`${id}-choice`}>
          <NativeSelect
            id={`${id}-choice`}
            value={form.create ? "new" : "existing"}
            disabled={disabled}
            onChange={(e) => setForm({ ...form, create: e.target.value === "new" })}
          >
            <option value="existing">Chọn repo có sẵn</option>
            <option value="new">Tạo repo riêng tư mới</option>
          </NativeSelect>
        </FormRow>
        <FormRow label="Chủ sở hữu" htmlFor={`${id}-owner`}>
          <Input
            id={`${id}-owner`}
            value={form.owner}
            disabled={disabled}
            onChange={(e) => setForm({ ...form, owner: e.target.value })}
          />
        </FormRow>
        <FormRow label="Tên repo" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={form.name}
            disabled={disabled}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </FormRow>
        <FormRow label="Nhánh" htmlFor={`${id}-branch`} hint="Để trống để dùng nhánh mặc định của repo.">
          <Input
            id={`${id}-branch`}
            value={form.branch}
            disabled={disabled}
            onChange={(e) => setForm({ ...form, branch: e.target.value })}
          />
        </FormRow>
        <DocsRepoFields form={form.docs} setForm={(docs) => setForm({ ...form, docs })} disabled={disabled} />
        <p className="text-sm text-muted-foreground">
          Repo mới luôn riêng tư. Tài liệu tổ chức nằm trong org/; tài liệu đội nằm trong teams/&lt;slug đội&gt;/. Ảnh
          nằm cạnh tài liệu trong thư mục assets/.
        </p>
      </SettingsSection>
    </>
  );
}

function formFromHome(home: DocHome | null) {
  return {
    connectionId: home?.connectionId ?? "",
    owner: home?.owner ?? "",
    name: home?.name ?? "org-docs",
    branch: home?.branch ?? "",
    create: false,
    docs: docsFormFromSettings({
      enabled: true,
      root: home?.root ?? "",
      assetsDir: home?.assetsDir ?? "assets",
      repoSync: home?.mode ?? "direct",
      include: home?.include ?? projectDocsSettings.parse({}).include,
      exclude: home?.exclude ?? projectDocsSettings.parse({}).exclude,
      repoChangesNeedReview: home?.repoChangesNeedReview ?? false,
      wordImportConfidential: home?.wordImportConfidential ?? false,
    }),
  };
}
