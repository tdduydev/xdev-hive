import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreatedInvitation, TeamRole } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { CopyField } from "@/components/outside/onboarding-copy-field.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { formError } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { emailsError, invitableRoles, MAX_INVITES, parseEmails } from "@/lib/invites.ts";
import { TEAM_ROLES } from "@/lib/roles.ts";
import { useOrg } from "@/shell/org-context.ts";

const linkText: Dict<{
  orgRoles: Record<"admin" | "member", string>;
  teamRoles: Record<TeamRole, string>;
  links: string;
  expires: (date: string) => string;
  linkFor: (email: string) => string;
  copyFor: (email: string) => string;
}> = {
  vi: {
    orgRoles: { admin: "Quản trị", member: "Thành viên" },
    teamRoles: { admin: "Quản trị", member: "Thành viên", viewer: "Chỉ xem", ba: "BA/PO", tester: "Tester" },
    links: "Link chỉ hiện một lần. Chép và gửi cho từng người ngay bây giờ. Mỗi link dùng được một lần",
    expires: (date) => `, hết hạn ngày ${date}`,
    linkFor: (email) => `Link mời cho ${email}`,
    copyFor: (email) => `link mời cho ${email}`,
  },
  en: {
    orgRoles: { admin: "Admin", member: "Member" },
    teamRoles: { admin: "Admin", member: "Member", viewer: "Viewer", ba: "BA/PO", tester: "Tester" },
    links: "Links are shown only once. Copy and send each person their link now. Each link can be used once",
    expires: (date) => `, expires on ${date}`,
    linkFor: (email) => `Invitation link for ${email}`,
    copyFor: (email) => `invitation link for ${email}`,
  },
};
const text: Dict<
  Record<
    "emailHint" | "orgRole" | "addTeam" | "noTeam" | "selectedTeam" | "teamRole" | "creating" | "create" | "more",
    string
  >
> = {
  vi: {
    emailHint: "Nhiều email cách nhau bằng dấu phẩy hoặc xuống dòng.",
    orgRole: "Vai trò tổ chức",
    addTeam: "Thêm vào đội",
    noTeam: "Không thêm",
    selectedTeam: "Đội đã chọn",
    teamRole: "Vai trò trong đội",
    creating: "Đang tạo lời mời…",
    create: "Tạo lời mời",
    more: "Mời thêm",
  },
  en: {
    emailHint: "Separate several emails with commas or new lines.",
    orgRole: "Organization role",
    addTeam: "Add to team",
    noTeam: "No team",
    selectedTeam: "Selected team",
    teamRole: "Team role",
    creating: "Creating invitations…",
    create: "Create invitations",
    more: "Invite more",
  },
};

interface InviteInput {
  emails: string[];
  orgRole: "admin" | "member";
  teamId?: string;
  teamRole?: TeamRole;
}

export interface OnboardingInviteFormProps {
  /** Tiêu đề: `DialogTitle` trong hộp thoại, tiêu đề bước trong màn tạo tổ chức. */
  title: ReactNode;
  /** Đội chọn sẵn ở ô t.addTeam (đội vừa tạo, hoặc đội đang xem). */
  defaultTeamId?: string | undefined;
  /** Nút bỏ qua khi chưa tạo lời mời: "Huỷ" trong hộp thoại, "Để sau" trong màn tạo tổ chức. */
  cancelLabel: string;
  /** Nút kết thúc sau khi đã có link. */
  doneLabel: string;
  onClose: () => void;
}

/**
 * Giữ bản riêng của onboarding để đổi ngôn ngữ mà không thay đổi các màn quản trị ngoài phạm vi task.
 * Tạo xong thì thay form bằng link của từng người: hub chỉ trả link đúng một lần.
 */
export function OnboardingInviteForm({
  title,
  defaultTeamId,
  cancelLabel,
  doneLabel,
  onClose,
}: OnboardingInviteFormProps) {
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
  const lang = useLang();
  const { org, api } = useOrg();
  const t = { ...useT(text), ...useT(linkText) };
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
    const emailsProblem =
      lang === "vi"
        ? emailsError(parsed)
        : parsed.invalid.length > 0
          ? `Invalid email: ${parsed.invalid.join(", ")}.`
          : parsed.emails.length === 0
            ? "Enter at least one email."
            : parsed.emails.length > MAX_INVITES
              ? `Invite up to ${MAX_INVITES} emails at a time.`
              : undefined;
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
          {errors.emails ?? t.emailHint}
        </small>
      </div>
      <div className="grid grid-cols-1 items-start gap-3.5 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-org-role`} className={label}>
            {t.orgRole}
          </label>
          <NativeSelect id={`${id}-org-role`} name="orgRole" defaultValue="member" disabled={busy}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {t.orgRoles[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-team`} className={label}>
            {t.addTeam}
          </label>
          <NativeSelect
            id={`${id}-team`}
            name="teamId"
            value={teamId}
            onChange={(e) => setTeamId(e.currentTarget.value)}
            disabled={busy}
          >
            <option value="">{t.noTeam}</option>
            {/* Đội chọn sẵn (vd. vừa tạo ở bước trước) có thể chưa có trong danh sách đang tải; giữ lựa chọn đó. */}
            {teamId && !teamOptions.some((t) => t.id === teamId) && <option value={teamId}>{t.selectedTeam}</option>}
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
              {t.teamRole}
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
                  {t.teamRoles[r]}
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
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? t.creating : t.create}
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
  const t = { ...useT(text), ...useT(linkText) };
  return (
    <div className="grid gap-3.5">
      {title}
      <p role="status" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
        {t.links}
        {expiresAt ? t.expires(formatDay(expiresAt)) : ""}.
      </p>
      <ul className="grid gap-3">
        {invitations.map((inv) => (
          <li key={inv.id}>
            <Field>
              <FieldLabel>{t.linkFor(inv.email)}</FieldLabel>
              <CopyField value={inv.link} copyLabel={t.copyFor(inv.email)} />
            </Field>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onMore}>
          {t.more}
        </Button>
        <Button variant="default" className="h-auto min-h-8 whitespace-normal text-center" onClick={onClose}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}
