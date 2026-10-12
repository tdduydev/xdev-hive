import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ProjectCreateInput, type ProjectCreateResult, projectCreateInput } from "@xdev-hive/contracts";
import { type FormEvent, useId, useState } from "react";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { SCM_LABEL, teamRoleLookup } from "../lib/projects.ts";
import { slugify } from "../lib/slug.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrg } from "../shell/org-context.ts";
import { Icon } from "./icons.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";
import { Select } from "./ui/select.tsx";

/** Nút "Tạo dự án" và dialog của nó; chỉ hiện cho quản trị đội hoặc quản trị tổ chức. */
export function CreateProjectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        Tạo dự án
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] w-140 overflow-y-auto">
          <CreateProjectForm onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

type Errors = Partial<Record<"systemId" | "name" | "key" | "connectionId" | "url" | "owner" | "repoName", string>>;

/** Ô của form ứng với đường dẫn issue của zod trong projectCreateInput. */
function fieldOf(path: readonly unknown[]): keyof Errors | undefined {
  const [top, sub] = path.map((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p)));
  if (top === "systemId" || top === "name" || top === "key") return top;
  if (top !== "repo") return undefined;
  if (sub === "url" || sub === "owner" || sub === "connectionId") return sub;
  if (sub === "name") return "repoName";
  return undefined;
}

function issuesToErrors(issues: readonly { path: readonly unknown[]; message: string }[]): Errors | null {
  const out: Errors = {};
  for (const issue of issues) {
    const field = fieldOf(issue.path);
    if (field) out[field] ??= issue.message;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Lỗi hub trả: lỗi kiểm đầu vào gắn vào ô, key hay repo đã có dự án dùng gắn vào ô đó, còn lại hiện chung. */
function serverErrors(error: unknown, mode: "existing" | "new"): { errors: Errors | null; message: string } {
  const message = apiErrorMessage(error);
  if (error instanceof ORPCError) {
    const data = error.data as { issues?: unknown; code?: unknown } | undefined;
    if (error.code === "BAD_REQUEST" && Array.isArray(data?.issues)) {
      const errors = issuesToErrors(data.issues as { path: unknown[]; message: string }[]);
      if (errors) return { errors, message };
    }
    if (error.code === "CONFLICT" && data?.code === "KEY_TAKEN") return { errors: { key: message }, message };
    if (error.code === "CONFLICT" && data?.code === "REPO_TAKEN") {
      return { errors: mode === "existing" ? { url: message } : { repoName: message }, message };
    }
  }
  return { errors: null, message };
}

interface Planned {
  input: ProjectCreateInput;
  plan: ProjectCreateResult;
}

/** Nội dung dialog nằm trong popup để mỗi lần mở lại là form mới. Một khoá chống trùng cho mỗi lần mở. */
function CreateProjectForm({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const { org, api } = useOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ids = { system: useId(), connection: useId(), visibility: useId() };
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const teams = useQuery(api.teams.list.queryOptions());
  const systems = useQuery(api.systems.list.queryOptions({ input: {} }));
  const members = useQuery(api.orgMembers.list.queryOptions());
  const connections = useQuery(api.scmConnections.list.queryOptions());
  const roleOf = teamRoleLookup(org.role, members.data, me.id);
  const teamName = new Map((teams.data ?? []).map((t) => [t.id, t.name]));
  const ownSystems = (systems.data ?? []).filter((s) => roleOf(s.teamId) === "admin");

  const [name, setName] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [connectionId, setConnectionId] = useState("");
  const [owner, setOwner] = useState<string | null>(null);
  const [repoName, setRepoName] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [planned, setPlanned] = useState<Planned | null>(null);

  const connection = connections.data?.find((c) => c.id === connectionId) ?? connections.data?.[0];
  const keyValue = key ?? slugify(name);

  const create = useMutation({
    mutationFn: (input: ProjectCreateInput) => api.projects.create.call(input),
    onSuccess: async (plan, input) => {
      if (plan.dryRun) {
        setPlanned({ input, plan });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: api.projects.key() });
      onDone();
      await navigate({ to: "/projects/$key", params: { key: input.key } });
    },
    onError: (error) => {
      const { errors: byField, message } = serverErrors(error, mode);
      if (byField) {
        setPlanned(null);
        setErrors(byField);
      } else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const read = (k: string) => String(form.get(k) ?? "").trim();
    const repo =
      mode === "existing"
        ? { mode, connectionId: connection?.id ?? "", url: read("url") }
        : {
            mode,
            connectionId: connection?.id ?? "",
            owner: read("owner"),
            name: read("repoName"),
            visibility: read("visibility") as "private" | "internal" | "public",
          };
    const input = {
      systemId: read("systemId"),
      name: read("name"),
      key: read("key"),
      repo,
      idempotencyKey,
      dryRun: true,
    };
    setFailure(null);
    const parsed = projectCreateInput.safeParse(input);
    if (!parsed.success) {
      const byField = issuesToErrors(parsed.error.issues);
      setErrors(byField ?? {});
      if (!byField) setFailure(parsed.error.issues[0]?.message ?? "Dữ liệu chưa hợp lệ.");
      return;
    }
    setErrors({});
    create.mutate(input);
  }

  const busy = create.isPending;
  if (planned) {
    return (
      <div className="grid gap-3.5">
        <DialogTitle>Kiểm tra trước khi tạo</DialogTitle>
        <DialogDescription>
          Hub sẽ làm các bước dưới đây cho <span className="font-mono">{planned.input.key}</span>. Bước nào lỗi thì xem
          và chạy lại ở trang dự án.
        </DialogDescription>
        <ol className="grid list-decimal gap-1 pl-5 text-foreground">
          {planned.plan.steps.map((s) => (
            <li key={`${s.kind}-${s.target ?? ""}`}>
              {s.title}
              {s.target && <span className="font-mono text-xs text-muted-foreground"> {s.target}</span>}
            </li>
          ))}
        </ol>
        {planned.plan.warnings.length > 0 && (
          <ul
            aria-label="Cảnh báo"
            className="grid gap-1 rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning"
          >
            {planned.plan.warnings.map((w) => (
              <li key={w.code}>{w.message}</li>
            ))}
          </ul>
        )}
        {failure && <Alert>{failure}</Alert>}
        <DialogActions>
          <Button variant="outline" onClick={() => setPlanned(null)} disabled={busy}>
            Quay lại sửa
          </Button>
          <Button
            variant="default"
            disabled={busy}
            onClick={() => {
              setFailure(null);
              create.mutate({ ...planned.input, dryRun: false });
            }}
          >
            {busy ? "Đang tạo…" : "Tạo dự án"}
          </Button>
        </DialogActions>
      </div>
    );
  }

  const loading = systems.isPending || connections.isPending || teams.isPending;
  const loadError = systems.error ?? connections.error ?? teams.error;
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>Tạo dự án</DialogTitle>
      <DialogDescription>
        Nối một repo có sẵn hoặc tạo repo mới. Hub thêm AGENTS.md, bảo vệ nhánh chính và webhook cho repo.
      </DialogDescription>
      {loading ? (
        <p aria-busy="true" className="text-muted-foreground">
          Đang tải…
        </p>
      ) : loadError ? (
        <Alert>{apiErrorMessage(loadError)}</Alert>
      ) : ownSystems.length === 0 || !connection ? (
        <Alert>
          {ownSystems.length === 0
            ? "Chưa có hệ thống nào trong đội bạn quản trị. Thêm hệ thống ở “Đội và hệ thống” trước."
            : "Tổ chức chưa có kết nối GitHub/GitLab. Nhờ quản trị tổ chức thêm kết nối trước."}
        </Alert>
      ) : (
        <>
          <Field invalid={errors.systemId !== undefined}>
            <FieldLabel htmlFor={ids.system}>Hệ thống</FieldLabel>
            <Select id={ids.system} name="systemId" disabled={busy}>
              {ownSystems.map((s) => (
                <option key={s.id} value={s.id}>
                  {teamName.get(s.teamId) ?? "Đội"} / {s.name}
                </option>
              ))}
            </Select>
            {errors.systemId && <FieldError>{errors.systemId}</FieldError>}
          </Field>
          <Field invalid={errors.name !== undefined}>
            <FieldLabel>Tên dự án</FieldLabel>
            <Input
              name="name"
              value={name}
              onValueChange={setName}
              placeholder="Ví dụ: Cổng thanh toán"
              disabled={busy}
              autoFocus
              autoComplete="off"
            />
            {errors.name && <FieldError>{errors.name}</FieldError>}
          </Field>
          <Field invalid={errors.key !== undefined}>
            <FieldLabel>Project key</FieldLabel>
            <Input
              name="key"
              value={keyValue}
              onValueChange={setKey}
              placeholder="cong-thanh-toan"
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            {errors.key ? (
              <FieldError>{errors.key}</FieldError>
            ) : (
              <FieldHint>Agent dùng key này khi gọi MCP; không đổi được sau khi tạo.</FieldHint>
            )}
          </Field>
          <Field invalid={errors.connectionId !== undefined}>
            <FieldLabel htmlFor={ids.connection}>Kết nối Git</FieldLabel>
            <Select
              id={ids.connection}
              value={connection.id}
              onChange={(e) => setConnectionId(e.currentTarget.value)}
              disabled={busy}
            >
              {connections.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {SCM_LABEL[c.kind]}: {c.name}
                </option>
              ))}
            </Select>
            {errors.connectionId && <FieldError>{errors.connectionId}</FieldError>}
          </Field>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-sm font-medium text-foreground">Repo</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {(
                [
                  ["existing", "Repo có sẵn"],
                  ["new", "Tạo repo mới"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name="repoMode"
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                    disabled={busy}
                    className="size-4 accent-accent"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          {mode === "existing" ? (
            <Field invalid={errors.url !== undefined}>
              <FieldLabel>URL repo</FieldLabel>
              <Input
                name="url"
                placeholder={
                  connection.kind === "github"
                    ? "https://github.com/acme/payment-api"
                    : "https://gitlab.com/acme/payment-api"
                }
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
              />
              {errors.url ? (
                <FieldError>{errors.url}</FieldError>
              ) : (
                <FieldHint>https hoặc ssh, không kèm token hay mật khẩu.</FieldHint>
              )}
            </Field>
          ) : (
            <>
              <div className="grid gap-3.5 app:grid-cols-2">
                <Field invalid={errors.owner !== undefined}>
                  <FieldLabel>{connection.kind === "github" ? "Tổ chức GitHub" : "Group GitLab"}</FieldLabel>
                  <Input
                    name="owner"
                    value={owner ?? connection.defaultOwner ?? ""}
                    onValueChange={setOwner}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {errors.owner && <FieldError>{errors.owner}</FieldError>}
                </Field>
                <Field invalid={errors.repoName !== undefined}>
                  <FieldLabel>Tên repo</FieldLabel>
                  <Input
                    name="repoName"
                    value={repoName ?? keyValue}
                    onValueChange={setRepoName}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {errors.repoName && <FieldError>{errors.repoName}</FieldError>}
                </Field>
              </div>
              <div className="grid gap-1.5">
                <label htmlFor={ids.visibility} className="text-sm font-medium text-foreground">
                  Ai xem được repo
                </label>
                <Select id={ids.visibility} name="visibility" defaultValue="private" disabled={busy}>
                  <option value="private">Riêng tư</option>
                  <option value="internal">Nội bộ tổ chức</option>
                  <option value="public">Công khai</option>
                </Select>
              </div>
            </>
          )}
        </>
      )}
      {failure && <Alert>{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          Huỷ
        </Button>
        <Button type="submit" variant="default" disabled={busy || loading || ownSystems.length === 0 || !connection}>
          {busy ? "Đang kiểm tra…" : "Kiểm tra"}
        </Button>
      </DialogActions>
    </form>
  );
}
