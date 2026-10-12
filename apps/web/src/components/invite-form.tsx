import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreatedInvitation, TeamRole } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { formError } from "../lib/api-errors.ts";
import { cx } from "../lib/cx.ts";
import { formatDay } from "../lib/format.ts";
import { emailsError, invitableRoles, parseEmails } from "../lib/invites.ts";
import { ORG_ROLE_LABEL, TEAM_ROLE_LABEL, TEAM_ROLES } from "../lib/roles.ts";
import { useOrg } from "../shell/org-context.ts";
import { CopyField } from "./copy-field.tsx";
import { Alert } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import { Field, FieldLabel } from "./ui/field.tsx";
import { NativeSelect } from "./ui/native-select.tsx";
import { Textarea } from "./ui/textarea.tsx";

interface InviteInput {
  emails: string[];
  orgRole: "admin" | "member";
  teamId?: string;
  teamRole?: TeamRole;
}

export interface InviteFormProps {
  /** Tiêu đề: `DialogTitle` trong hộp thoại, tiêu đề bước trong màn tạo tổ chức. */
  title: ReactNode;
  /** Đội chọn sẵn ở ô "Thêm vào đội" (đội vừa tạo, hoặc đội đang xem). */
  defaultTeamId?: string | undefined;
  /** Nút bỏ qua khi chưa tạo lời mời: "Huỷ" trong hộp thoại, "Để sau" trong màn tạo tổ chức. */
  cancelLabel: string;
  /** Nút kết thúc sau khi đã có link. */
  doneLabel: string;
  onClose: () => void;
}

/**
 * Form mời người theo mockup (hộp thoại "Mời người vào tổ chức"), dùng chung cho màn Thành viên, màn Đội và hệ thống,
 * và bước 3 của màn tạo tổ chức. Tạo xong thì thay form bằng link của từng người: hub chỉ trả link đúng một lần.
 */
export function InviteForm({ title, defaultTeamId, cancelLabel, doneLabel, onClose }: InviteFormProps) {
  const [created, setCreated] = useState<CreatedInvitation[] | null>(null);
  return created ? (
    <InviteLinks
      title={title}
      invitations={created}
      doneLabel={doneLabel}
      onMore={() => setCreated(null)}
      onClose={onClose}
    />
  ) : (
    <InviteFields
      title={title}
      defaultTeamId={defaultTeamId}
      cancelLabel={cancelLabel}
      onCancel={onClose}
      onCreated={setCreated}
    />
  );
}

type FieldErrors = { emails?: string | undefined; teamRole?: string | undefined };

// Nhãn viết tay cho ô gốc (<select>, <textarea>): Field của Base UI chỉ tự nối nhãn và lỗi với ô của chính nó.
const label = "text-sm font-medium text-foreground";

function InviteFields({
  title,
  defaultTeamId,
  cancelLabel,
  onCancel,
  onCreated,
}: {
  title: ReactNode;
  defaultTeamId: string | undefined;
  cancelLabel: string;
  onCancel: () => void;
  onCreated: (invitations: CreatedInvitation[]) => void;
}) {
  const { org, api } = useOrg();
  const queryClient = useQueryClient();
  const teams = useQuery(api.teams.list.queryOptions());
  const roles = invitableRoles(org.role);
  const [teamId, setTeamId] = useState(defaultTeamId ?? "");
  const id = useId();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (input: InviteInput) => api.invitations.create.call(input),
    onSuccess: async ({ invitations }) => {
      await queryClient.invalidateQueries({ queryKey: api.invitations.key() });
      onCreated(invitations);
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "emails" || field === "teamRole") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const parsed = parseEmails(String(form.get("emails") ?? ""));
    const emailsProblem = emailsError(parsed);
    setErrors({ emails: emailsProblem });
    setFailure(null);
    if (emailsProblem) return;
    const orgRole = roles.find((r) => r === form.get("orgRole")) ?? "member";
    const teamRole = TEAM_ROLES.find((r) => r === form.get("teamRole"));
    create.mutate({
      emails: parsed.emails,
      orgRole,
      ...(teamId ? { teamId, ...(teamRole ? { teamRole } : {}) } : {}),
    });
  }

  const busy = create.isPending;
  const teamOptions = teams.data ?? [];
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      {title}
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-emails`} className={label}>
          Email
        </label>
        {/* Ô nhiều dòng thay cho ô một dòng của mockup: dán danh sách nhiều dòng vào <input> thì mất dấu xuống dòng,
            các email dính vào nhau. */}
        <Textarea
          id={`${id}-emails`}
          name="emails"
          rows={2}
          placeholder="ten@congty.vn, ten2@congty.vn"
          disabled={busy}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.emails ? true : undefined}
          aria-describedby={`${id}-emails-note`}
          className="min-h-0"
        />
        <small
          id={`${id}-emails-note`}
          className={cx("text-xs", errors.emails ? "text-destructive" : "text-muted-foreground")}
        >
          {errors.emails ?? "Nhiều email cách nhau bằng dấu phẩy hoặc xuống dòng."}
        </small>
      </div>
      <div className="grid grid-cols-1 items-start gap-3.5 app:grid-cols-2">
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-org-role`} className={label}>
            Vai trò tổ chức
          </label>
          <NativeSelect id={`${id}-org-role`} name="orgRole" defaultValue="member" disabled={busy}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ORG_ROLE_LABEL[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-team`} className={label}>
            Thêm vào đội
          </label>
          <NativeSelect
            id={`${id}-team`}
            name="teamId"
            value={teamId}
            onChange={(e) => setTeamId(e.currentTarget.value)}
            disabled={busy}
          >
            <option value="">Không thêm</option>
            {/* Đội chọn sẵn (vd. vừa tạo ở bước trước) có thể chưa có trong danh sách đang tải; giữ lựa chọn đó. */}
            {teamId && !teamOptions.some((t) => t.id === teamId) && <option value={teamId}>Đội đã chọn</option>}
            {teamOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        {teamId && (
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-team-role`} className={label}>
              Vai trò trong đội
            </label>
            <NativeSelect
              id={`${id}-team-role`}
              name="teamRole"
              defaultValue="member"
              disabled={busy}
              aria-invalid={errors.teamRole ? true : undefined}
              aria-describedby={errors.teamRole ? `${id}-team-role-error` : undefined}
            >
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {TEAM_ROLE_LABEL[r]}
                </option>
              ))}
            </NativeSelect>
            {errors.teamRole && (
              <small id={`${id}-team-role-error`} className="text-xs text-destructive">
                {errors.teamRole}
              </small>
            )}
          </div>
        )}
      </div>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? "Đang tạo lời mời…" : "Tạo lời mời"}
        </Button>
      </div>
    </form>
  );
}

function InviteLinks({
  title,
  invitations,
  doneLabel,
  onMore,
  onClose,
}: {
  title: ReactNode;
  invitations: CreatedInvitation[];
  doneLabel: string;
  onMore: () => void;
  onClose: () => void;
}) {
  const expiresAt = invitations[0]?.expiresAt;
  return (
    <div className="grid gap-3.5">
      {title}
      <p role="status" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
        Link chỉ hiện một lần. Chép và gửi cho từng người ngay bây giờ. Mỗi link dùng được một lần
        {expiresAt ? `, hết hạn ngày ${formatDay(expiresAt)}` : ""}.
      </p>
      <ul className="grid gap-3">
        {invitations.map((inv) => (
          <li key={inv.id}>
            <Field>
              <FieldLabel>Link mời cho {inv.email}</FieldLabel>
              <CopyField value={inv.link} copyLabel={`link mời cho ${inv.email}`} />
            </Field>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onMore}>
          Mời thêm
        </Button>
        <Button variant="default" onClick={onClose}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
