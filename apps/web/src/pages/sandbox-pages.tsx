import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { envImageInput, type Project, SUGGESTED_EGRESS_RULES } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { AllowlistEditor } from "../components/allowlist-editor.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { LoadFailure, LoadingState } from "../components/ui/query-state.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { teamRoleLookup } from "../lib/projects.ts";
import { isOrgAdmin } from "../lib/roles.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="grid gap-3 p-5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children}
    </Card>
  );
}

/** Chính sách sandbox của tổ chức: khoá allowlist, danh sách đề xuất và mục mạng dùng chung cho mọi dự án. */
export function SandboxAdminPage() {
  const { api, org } = useOrg();
  const queryClient = useQueryClient();
  const settings = useQuery(api.sandbox.getOrgSettings.queryOptions({ input: {} }));
  const admin = isOrgAdmin(org.role);
  // Bản nháp cập nhật ngay khi bấm: ô chọn điều khiển bằng dữ liệu hub sẽ bật ngược lại tới khi hub trả lời.
  const [draft, setDraft] = useState<{ locked: boolean; useSuggestedDefaults: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (next: { locked: boolean; useSuggestedDefaults: boolean }) => api.sandbox.updateOrgSettings.call(next),
    // Ghi kết quả hub trả vào cache để ô chọn giữ trạng thái mới; allowlist hiệu lực của dự án thì đổi theo.
    onError: () => setDraft(null),
    onSuccess: async (next) => {
      queryClient.setQueryData(api.sandbox.getOrgSettings.queryKey({ input: {} }), next);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: api.sandbox.effectiveAllowlist.key() });
    },
  });

  let policy: ReactNode;
  if (settings.isPending) policy = <LoadingState />;
  else if (settings.isError) policy = <LoadFailure error={settings.error} retry={settings.refetch} />;
  else {
    const s = draft ?? settings.data;
    const change = (next: { locked: boolean; useSuggestedDefaults: boolean }) => {
      setDraft(next);
      save.mutate(next);
    };
    policy = (
      <div className="grid gap-3">
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={s.useSuggestedDefaults}
            disabled={!admin || save.isPending}
            onChange={(e) => change({ ...s, useSuggestedDefaults: e.target.checked })}
          />
          <span>
            <b className="font-medium text-foreground">Dùng danh sách đề xuất</b>
            <span className="block text-muted-foreground">
              Cho run ra các địa chỉ hay cần: <code className="font-mono">{SUGGESTED_EGRESS_RULES.join(", ")}</code>
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            checked={s.locked}
            disabled={!admin || save.isPending}
            onChange={(e) => change({ ...s, locked: e.target.checked })}
          />
          <span>
            <b className="font-medium text-foreground">Khoá allowlist</b>
            <span className="block text-muted-foreground">
              Dự án không thêm được mục riêng; chỉ dùng mục của tổ chức.
            </span>
          </span>
        </label>
        {save.isError && <Alert>{apiErrorMessage(save.error)}</Alert>}
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Sandbox" />
      <PageBody>
        {!admin && (
          <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-xs text-foreground">
            Bạn đang xem ở chế độ chỉ đọc. Chỉ quản trị tổ chức sửa được chính sách sandbox.
          </p>
        )}
        <Section title="Chính sách của tổ chức">{policy}</Section>
        <Section title="Mục mạng của tổ chức">
          <p className="text-xs text-muted-foreground">
            Áp dụng cho run sandbox của mọi dự án trong tổ chức. Mặc định chặn hết.
          </p>
          <AllowlistEditor canEdit={admin} />
        </Section>
      </PageBody>
    </>
  );
}

/** Sandbox của một dự án: allowlist hiệu lực, mục riêng của dự án và image môi trường. */
export function ProjectSandboxPage() {
  const { key } = useParams({ from: "/session/app/in-org/projects/$key/sandbox" });
  const { api, org } = useOrg();
  const me = useMe();
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const members = useQuery(api.orgMembers.list.queryOptions({ input: {} }));
  const project = projects.data?.find((p) => p.key === key);
  const crumb = (
    <>
      <Link to="/projects" className="text-primary hover:text-primary/90">
        Dự án
      </Link>
      {" / "}
      <span className="font-mono">{key}</span>
      {" / Sandbox"}
    </>
  );

  let body: ReactNode;
  if (projects.isPending || members.isPending) body = <LoadingState />;
  else if (projects.isError) body = <LoadFailure error={projects.error} retry={projects.refetch} />;
  else if (!project) body = <Alert>{`Không tìm thấy dự án ${key}, hoặc bạn không ở trong đội sở hữu dự án.`}</Alert>;
  else {
    const canEdit = teamRoleLookup(org.role, members.data, me.id)(project.teamId) === "admin";
    body = <ProjectSandbox project={project} canEdit={canEdit} />;
  }
  return (
    <>
      <PageHeader crumb={crumb} title="Sandbox" />
      <PageBody>{body}</PageBody>
    </>
  );
}

function ProjectSandbox({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const { api } = useOrg();
  const effective = useQuery(api.sandbox.effectiveAllowlist.queryOptions({ input: { projectId: project.id } }));
  return (
    <>
      {!project.settings.features.sandbox && (
        <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-xs text-foreground">
          Dự án chưa bật sandbox nên run vẫn chạy trên máy dev. Bật ở{" "}
          <Link
            to="/projects/$key/settings"
            params={{ key: project.key }}
            className="text-primary hover:text-primary/90"
          >
            cấu hình dự án
          </Link>
          .
        </p>
      )}
      <Section title="Allowlist hiệu lực">
        {effective.isPending ? (
          <LoadingState />
        ) : effective.isError ? (
          <LoadFailure error={effective.error} retry={effective.refetch} />
        ) : effective.data.rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">Run sandbox của dự án không ra được địa chỉ nào.</p>
        ) : (
          <ul aria-label="Allowlist hiệu lực" className="flex flex-wrap gap-1.5">
            {effective.data.rules.map((rule) => (
              <li key={rule}>
                <code className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-foreground">{rule}</code>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Gộp từ danh sách đề xuất (nếu tổ chức bật), mục của tổ chức và mục của dự án.
        </p>
      </Section>
      <Section title="Mục mạng của dự án">
        <AllowlistEditor
          projectId={project.id}
          canEdit={canEdit}
          {...(effective.data?.locked
            ? { lockedNote: "Tổ chức đã khoá allowlist: dự án không thêm được mục riêng." }
            : {})}
        />
      </Section>
      <Section title="Image môi trường">
        <EnvImageForm project={project} canEdit={canEdit} />
      </Section>
    </>
  );
}

function EnvImageForm({ project, canEdit }: { project: Project; canEdit: boolean }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const ids = { image: useId(), hash: useId() };
  const image = useQuery(api.sandbox.getImage.queryOptions({ input: { projectId: project.id } }));
  const [errors, setErrors] = useState<{ baseImage?: string; setupScriptHash?: string }>({});
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: (input: { baseImage: string; setupScriptHash: string }) =>
      api.sandbox.setImage.call({ projectId: project.id, ...input }),
    onSuccess: async () => {
      setDone(true);
      await queryClient.invalidateQueries({ queryKey: api.sandbox.getImage.key() });
    },
  });

  if (image.isPending) return <LoadingState />;
  if (image.isError) return <LoadFailure error={image.error} retry={image.refetch} />;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setDone(false);
    const data = new FormData(e.currentTarget);
    const parsed = envImageInput.safeParse({
      baseImage: String(data.get("baseImage") ?? "").trim(),
      setupScriptHash: String(data.get("setupScriptHash") ?? "")
        .trim()
        .toLowerCase(),
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof typeof errors;
        next[field] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3">
      <Field invalid={errors.baseImage !== undefined}>
        <FieldLabel htmlFor={ids.image}>Image gốc</FieldLabel>
        <Input
          id={ids.image}
          name="baseImage"
          defaultValue={image.data?.baseImage ?? ""}
          placeholder="node:24-bookworm-slim"
          className="font-mono"
          disabled={!canEdit}
        />
        {errors.baseImage ? (
          <FieldError>{errors.baseImage}</FieldError>
        ) : (
          <FieldHint>Image có sẵn CLI agent cần dùng; runner host dựng và cache theo hash script setup.</FieldHint>
        )}
      </Field>
      <Field invalid={errors.setupScriptHash !== undefined}>
        <FieldLabel htmlFor={ids.hash}>SHA-256 của .hive/setup.sh</FieldLabel>
        <Input
          id={ids.hash}
          name="setupScriptHash"
          defaultValue={image.data?.setupScriptHash ?? ""}
          className="font-mono"
          disabled={!canEdit}
        />
        {errors.setupScriptHash ? (
          <FieldError>{errors.setupScriptHash}</FieldError>
        ) : (
          <FieldHint>
            Lấy bằng <code className="font-mono">sha256sum .hive/setup.sh</code> trong repo của dự án.
          </FieldHint>
        )}
      </Field>
      {save.isError && <Alert>{apiErrorMessage(save.error)}</Alert>}
      {done && (
        <p role="status" className="text-xs text-success">
          Đã lưu image môi trường.
        </p>
      )}
      {canEdit && (
        <div className="flex justify-end">
          <Button type="submit" variant="default" disabled={save.isPending}>
            {save.isPending ? "Đang lưu…" : "Lưu image"}
          </Button>
        </div>
      )}
    </form>
  );
}
