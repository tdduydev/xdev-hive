import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { InvitationPreview, Me } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useState } from "react";
import { Brand, Icon } from "../components/icons.tsx";
import { OutsideLayout } from "../components/outside/outside-layout.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { authClient, signUpWithInvite } from "../lib/auth-client.ts";
import { type AuthErrorLike, authErrorLabel } from "../lib/auth-errors.ts";
import { formatDay } from "../lib/format.ts";
import { type Dict, useT } from "../lib/i18n.ts";
import { isInviteToken, joinedOrg, sameEmail } from "../lib/invites.ts";
import { meQuery } from "../lib/me.ts";
import { orgStore } from "../lib/org-store.ts";
import { orgsMineQuery } from "../lib/orgs.ts";
import { client, orpc } from "../lib/rpc.ts";
import { cn } from "../lib/utils.ts";

const inviteText: Dict<{
  title: (name: string) => string;
  used: (invite: InvitationPreview) => string;
  expired: (invite: InvitationPreview) => string;
  until: (date: string) => string;
  entering: (name: string) => string;
  other: (email: string, current: string) => string;
  match: (email: string, name: string) => string;
  passwordHint: string;
  passwordError: string;
  existingHint: (email: string) => string;
}> = {
  vi: {
    title: (name) => `Lời mời vào ${name}`,
    used: (invite) =>
      `Lời mời vào ${invite.orgName} cho ${invite.email} đã được nhận. Mỗi link chỉ dùng được một lần. Nếu đó là bạn, đăng nhập để vào tổ chức; nếu không, nhờ quản trị tổ chức gửi lời mời mới.`,
    expired: (invite) =>
      `Lời mời vào ${invite.orgName} cho ${invite.email} đã hết hạn ngày ${formatDay(invite.expiresAt)}. Nhờ quản trị tổ chức gửi lời mời mới.`,
    until: (date) => `Dùng trước ngày ${date}, một lần`,
    entering: (name) => `Đang vào ${name}…`,
    other: (email, current) =>
      `Lời mời này dành cho ${email}, nhưng bạn đang đăng nhập bằng ${current}. Đăng xuất rồi mở lại link này.`,
    match: (email, name) => `Bạn đang đăng nhập bằng ${email}. Nhận lời mời để vào ${name}.`,
    passwordHint: "Ít nhất 10 ký tự.",
    passwordError: "Mật khẩu cần ít nhất 10 ký tự.",
    existingHint: (email) => `Dùng tài khoản có email ${email} (đã xác minh với GitHub/GitLab).`,
  },
  en: {
    title: (name) => `Invitation to ${name}`,
    used: (invite) =>
      `The invitation to ${invite.orgName} for ${invite.email} has been accepted. Each link can be used once. If that was you, sign in to join; otherwise, ask an organization admin for a new invitation.`,
    expired: (invite) =>
      `The invitation to ${invite.orgName} for ${invite.email} expired on ${formatDay(invite.expiresAt)}. Ask an organization admin for a new one.`,
    until: (date) => `Use once before ${date}`,
    entering: (name) => `Joining ${name}…`,
    other: (email, current) =>
      `This invitation is for ${email}, but you are signed in as ${current}. Sign out and open the link again.`,
    match: (email, name) => `You are signed in as ${email}. Accept to join ${name}.`,
    passwordHint: "At least 10 characters.",
    passwordError: "Password must contain at least 10 characters.",
    existingHint: (email) => `Use an account with the email ${email} (verified with GitHub/GitLab).`,
  },
};
const text: Dict<
  Record<
    | "invalidTitle"
    | "invalidBody"
    | "inviteTitle"
    | "loading"
    | "missingTitle"
    | "errorTitle"
    | "usedTitle"
    | "expiredTitle"
    | "org"
    | "email"
    | "expires"
    | "home"
    | "signIn"
    | "signOutError"
    | "signingOut"
    | "signOut"
    | "enteringOrg"
    | "accept"
    | "nameError"
    | "createTitle"
    | "name"
    | "password"
    | "creating"
    | "create"
    | "or"
    | "existing",
    string
  >
> = {
  vi: {
    invalidTitle: "Link mời không hợp lệ",
    invalidBody: "Link bị thiếu hoặc thừa ký tự. Chép lại đủ link, hoặc nhờ quản trị tổ chức gửi lại.",
    inviteTitle: "Lời mời",
    loading: "Đang tải…",
    missingTitle: "Không tìm thấy lời mời",
    errorTitle: "Không mở được lời mời",
    usedTitle: "Lời mời đã được dùng",
    expiredTitle: "Lời mời đã hết hạn",
    org: "Tổ chức",
    email: "Email được mời",
    expires: "Hạn",
    home: "Về trang chủ",
    signIn: "Đăng nhập",
    signOutError: "Không đăng xuất được. Thử lại.",
    signingOut: "Đang đăng xuất…",
    signOut: "Đăng xuất",
    enteringOrg: "Đang vào tổ chức…",
    accept: "Nhận lời mời và vào tổ chức",
    nameError: "Nhập họ và tên.",
    createTitle: "Tạo tài khoản bằng email",
    name: "Họ và tên",
    password: "Mật khẩu",
    creating: "Đang tạo tài khoản…",
    create: "Tạo tài khoản và vào tổ chức",
    or: "hoặc",
    existing: "Đăng nhập bằng GitHub, GitLab hoặc tài khoản đã có",
  },
  en: {
    invalidTitle: "Invalid invitation link",
    invalidBody:
      "The link has missing or extra characters. Copy the full link or ask an organization admin to send it again.",
    inviteTitle: "Invitation",
    loading: "Loading…",
    missingTitle: "Invitation not found",
    errorTitle: "Cannot open invitation",
    usedTitle: "Invitation already used",
    expiredTitle: "This invitation has expired",
    org: "Organization",
    email: "Invited email",
    expires: "Valid until",
    home: "Go home",
    signIn: "Sign in",
    signOutError: "Could not sign out. Try again.",
    signingOut: "Signing out…",
    signOut: "Sign out",
    enteringOrg: "Joining organization…",
    accept: "Accept and join",
    nameError: "Enter your full name.",
    createTitle: "Create an account with email",
    name: "Full name",
    password: "Password",
    creating: "Creating account…",
    create: "Create account and join",
    or: "or",
    existing: "Sign in with GitHub, GitLab or an existing account",
  },
};

/** Độ dài tối thiểu mật khẩu, khớp `minPasswordLength` của Better Auth trong apps/hub (identity/auth.ts). */
const MIN_PASSWORD = 10;

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <OutsideLayout>
      <Card className="grid w-full max-w-115 gap-5 p-6 sm:p-8 shadow-lg">
        <Brand />
        <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {children}
      </Card>
    </OutsideLayout>
  );
}

/**
 * Trang mở link mời /invite/<mã>. Đứng ngoài khung app và mở được khi chưa đăng nhập: người được mời thường chưa có
 * tài khoản. Xem trước lời mời, cho đăng nhập hoặc đăng ký bằng email kèm mã mời, rồi nhận lời mời và vào tổ chức.
 */
export function InvitePage() {
  const t = { ...useT(text), ...useT(inviteText) };
  const { token } = useParams({ from: "/invite/$token" });
  const { data: me } = useSuspenseQuery(meQuery);
  // Vừa đăng ký xong: phiên mới làm trang đổi sang phần "nhận lời mời" trong lúc chờ chuyển trang; giữ màn chờ.
  const [entering, setEntering] = useState(false);
  const preview = useQuery({
    ...orpc.invitations.preview.queryOptions({ input: { token } }),
    enabled: isInviteToken(token),
  });

  if (!isInviteToken(token))
    return (
      <Frame title={t.invalidTitle}>
        <p className="text-muted-foreground">{t.invalidBody}</p>
        <HomeLink signedIn={me !== null} />
      </Frame>
    );
  if (preview.isPending)
    return (
      <Frame title={t.inviteTitle}>
        <p aria-busy="true" className="text-muted-foreground">
          {t.loading}
        </p>
      </Frame>
    );
  if (preview.isError) {
    const notFound = preview.error instanceof ORPCError && preview.error.code === "NOT_FOUND";
    return (
      <Frame title={notFound ? t.missingTitle : t.errorTitle}>
        <Alert variant="destructive">{apiErrorMessage(preview.error)}</Alert>
        <HomeLink signedIn={me !== null} />
      </Frame>
    );
  }
  const invite = preview.data;
  if (invite.status === "accepted")
    return (
      <Frame title={t.usedTitle}>
        <p className="text-muted-foreground">{t.used(invite)}</p>
        <HomeLink signedIn={me !== null} />
      </Frame>
    );
  if (invite.status === "expired")
    return (
      <Frame title={t.expiredTitle}>
        <p className="text-muted-foreground">{t.expired(invite)}</p>
        <HomeLink signedIn={me !== null} />
      </Frame>
    );

  return (
    <Frame title={t.title(invite.orgName)}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg bg-muted px-3.5 py-3 text-sm">
        <dt className="text-muted-foreground">{t.org}</dt>
        <dd className="font-medium text-foreground">{invite.orgName}</dd>
        <dt className="text-muted-foreground">{t.email}</dt>
        <dd className="break-all font-mono text-foreground">{invite.email}</dd>
        <dt className="text-muted-foreground">{t.expires}</dt>
        <dd className="text-foreground">{t.until(formatDay(invite.expiresAt))}</dd>
      </dl>
      {entering ? (
        <p aria-busy="true" className="text-muted-foreground">
          {t.entering(invite.orgName)}
        </p>
      ) : me ? (
        <AcceptInvite token={token} invite={invite} me={me} />
      ) : (
        <SignUpForInvite token={token} invite={invite} onEntering={() => setEntering(true)} />
      )}
    </Frame>
  );
}

function HomeLink({ signedIn }: { signedIn: boolean }) {
  const t = { ...useT(text), ...useT(inviteText) };
  return signedIn ? (
    <Link to="/" className={buttonVariants({ variant: "default" })}>
      {t.home}
    </Link>
  ) : (
    <Link to="/login" className={buttonVariants({ variant: "default" })}>
      {t.signIn}
    </Link>
  );
}

/**
 * Sau khi vào tổ chức: chọn làm tổ chức đang làm việc, rồi về trang chủ. Route kiểm phiên và tổ chức trên cache, nên
 * tải lại người đang đăng nhập và danh sách tổ chức trước khi chuyển trang.
 */
function useEnterOrg() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async (orgId: string) => {
    orgStore.set(orgId);
    await Promise.all([
      queryClient.fetchQuery({ ...meQuery, staleTime: 0 }),
      queryClient.fetchQuery({ ...orgsMineQuery, staleTime: 0 }),
    ]);
    await navigate({ to: "/", replace: true });
  };
}

function AcceptInvite({ token, invite, me }: { token: string; invite: InvitationPreview; me: Me }) {
  const t = { ...useT(text), ...useT(inviteText) };
  const enterOrg = useEnterOrg();
  const accept = useMutation({
    mutationFn: () => client.invitations.accept({ token }),
    onSuccess: (org) => enterOrg(org.id),
  });
  const signOut = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut();
      if (error) throw error;
    },
    // Tải lại đúng trang này để xem lời mời như người chưa đăng nhập, và xoá cache của tài khoản vừa thoát.
    onSuccess: () => window.location.reload(),
  });

  if (!sameEmail(me.email, invite.email))
    return (
      <>
        <p role="alert" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          {t.other(invite.email, me.email)}
        </p>
        {signOut.isError && <Alert variant="destructive">{t.signOutError}</Alert>}
        <div className="flex justify-end gap-2">
          <Link to="/" className={buttonVariants({ variant: "ghost" })}>
            {t.home}
          </Link>
          <Button variant="default" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            <Icon name="logout" />
            {signOut.isPending ? t.signingOut : t.signOut}
          </Button>
        </div>
      </>
    );

  const busy = accept.isPending || accept.isSuccess;
  return (
    <>
      <p className="text-muted-foreground">{t.match(me.email, invite.orgName)}</p>
      {accept.isError && <Alert variant="destructive">{apiErrorMessage(accept.error)}</Alert>}
      <Button
        variant="default"
        className="h-auto min-h-9 w-full whitespace-normal text-center"
        disabled={busy}
        onClick={() => accept.mutate()}
      >
        {busy ? t.enteringOrg : t.accept}
      </Button>
    </>
  );
}

type SignUpErrors = { name?: string | undefined; password?: string | undefined };

/** Better Auth từ chối tạo tài khoản; message là câu tiếng Việt đã dịch từ mã lỗi. */
class SignUpError extends Error {}

function SignUpForInvite({
  token,
  invite,
  onEntering,
}: {
  token: string;
  invite: InvitationPreview;
  onEntering: () => void;
}) {
  const queryClient = useQueryClient();
  const t = { ...useT(text), ...useT(inviteText) };
  const enterOrg = useEnterOrg();
  const [errors, setErrors] = useState<SignUpErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const signUp = useMutation({
    mutationFn: async (input: { name: string; password: string }) => {
      let error: AuthErrorLike | null;
      try {
        // Hub đọc `inviteToken` trong body: kiểm mã trước khi tạo tài khoản, rồi tự nhận lời mời ngay sau đó.
        ({ error } = await signUpWithInvite({ ...input, email: invite.email, inviteToken: token }));
      } catch {
        error = { status: 0 };
      }
      if (error) throw new SignUpError(authErrorLabel(error, "signup"));
      const { orgs } = await queryClient.fetchQuery({ ...orgsMineQuery, staleTime: 0 });
      // Hub không báo lỗi khi tự nhận lời mời hỏng sau lúc đã tạo tài khoản; nhận lại ở đây để thấy lý do.
      return joinedOrg(orgs, invite.orgName)?.id ?? (await client.invitations.accept({ token })).id;
    },
    onSuccess: (orgId) => {
      onEntering();
      return enterOrg(orgId);
    },
    onError: (error) => {
      setFailure(error instanceof SignUpError ? error.message : apiErrorMessage(error));
      // Tài khoản đã tạo xong mà chưa vào được tổ chức: tải lại phiên để trang chuyển sang phần nhận lời mời, nơi
      // thử lại được, thay vì để người dùng đăng ký lại và gặp lỗi email đã có.
      if (!(error instanceof SignUpError)) void queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const local: SignUpErrors = {
      name: name ? undefined : t.nameError,
      password: password.length >= MIN_PASSWORD ? undefined : t.passwordError,
    };
    setErrors(local);
    setFailure(null);
    if (local.name || local.password) return;
    signUp.mutate({ name, password });
  }

  const busy = signUp.isPending || signUp.isSuccess;
  return (
    <>
      <form noValidate onSubmit={onSubmit} className="grid gap-3">
        <h2 className="text-base font-semibold text-foreground">{t.createTitle}</h2>
        <Field invalid={errors.name !== undefined}>
          <FieldLabel>{t.name}</FieldLabel>
          <Input name="name" autoComplete="name" disabled={busy} autoFocus />
          {errors.name && <FieldError>{errors.name}</FieldError>}
        </Field>
        <Field>
          <FieldLabel>Email</FieldLabel>
          {/* Hub chỉ nhận đăng ký đúng email được mời, nên không cho sửa. */}
          <Input
            name="email"
            type="email"
            value={invite.email}
            readOnly
            autoComplete="username"
            className="bg-muted text-muted-foreground"
          />
        </Field>
        <Field invalid={errors.password !== undefined}>
          <FieldLabel>{t.password}</FieldLabel>
          <Input name="password" type="password" autoComplete="new-password" disabled={busy} />
          {errors.password ? <FieldError>{errors.password}</FieldError> : <FieldHint>{t.passwordHint}</FieldHint>}
        </Field>
        {failure && <Alert variant="destructive">{failure}</Alert>}
        <Button
          type="submit"
          variant="default"
          className="h-auto min-h-9 w-full whitespace-normal text-center"
          disabled={busy}
        >
          <Icon name="mail" />
          {busy ? t.creating : t.create}
        </Button>
      </form>
      <div className="flex items-center gap-2.5 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
        {t.or}
      </div>
      <div className="grid gap-1.5">
        {/* Đăng nhập rồi quay lại đúng trang này để nhận lời mời; trang đăng nhập có đủ SSO, GitHub, GitLab, email.
            GitHub/GitLab lần đầu cũng tạo được tài khoản nhờ lời mời này, nếu email ở đó trùng email được mời. */}
        <Link
          to="/login"
          search={{ redirect: `/invite/${token}` }}
          className={cn(buttonVariants({ variant: "outline" }), "h-auto min-h-9 w-full whitespace-normal text-center")}
        >
          <Icon name="key" />
          {t.existing}
        </Link>
        <small className="text-center text-xs text-muted-foreground">{t.existingHint(invite.email)}</small>
      </div>
    </>
  );
}
