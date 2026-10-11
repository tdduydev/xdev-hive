import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { InvitationPreview, Me } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useState } from "react";
import { Brand, Icon } from "../components/icons.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button, buttonClass } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { authClient, signUpWithInvite } from "../lib/auth-client.ts";
import { type AuthErrorLike, authErrorLabel } from "../lib/auth-errors.ts";
import { formatDay } from "../lib/format.ts";
import { isInviteToken, joinedOrg, sameEmail } from "../lib/invites.ts";
import { meQuery } from "../lib/me.ts";
import { orgStore } from "../lib/org-store.ts";
import { orgsMineQuery } from "../lib/orgs.ts";
import { client, orpc } from "../lib/rpc.ts";

/** Độ dài tối thiểu mật khẩu, khớp `minPasswordLength` của Better Auth trong apps/hub (identity/auth.ts). */
const MIN_PASSWORD = 10;

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-6">
      <Card className="grid w-full max-w-110 gap-4 p-7">
        <Brand />
        <h1 className="mt-1 text-4xl font-bold tracking-tight text-ink">{title}</h1>
        {children}
      </Card>
    </main>
  );
}

/**
 * Trang mở link mời /moi/<mã>. Đứng ngoài khung app và mở được khi chưa đăng nhập: người được mời thường chưa có
 * tài khoản. Xem trước lời mời, cho đăng nhập hoặc đăng ký bằng email kèm mã mời, rồi nhận lời mời và vào tổ chức.
 */
export function InvitePage() {
  const { token } = useParams({ from: "/moi/$token" });
  const { data: me } = useSuspenseQuery(meQuery);
  // Vừa đăng ký xong: phiên mới làm trang đổi sang phần "nhận lời mời" trong lúc chờ chuyển trang; giữ màn chờ.
  const [entering, setEntering] = useState(false);
  const preview = useQuery({
    ...orpc.invitations.preview.queryOptions({ input: { token } }),
    enabled: isInviteToken(token),
  });

  if (!isInviteToken(token))
    return (
      <Frame title="Link mời không hợp lệ">
        <p className="text-muted">
          Link bị thiếu hoặc thừa ký tự. Chép lại đủ link, hoặc nhờ quản trị tổ chức gửi lại.
        </p>
        <HomeLink signedIn={me !== null} />
      </Frame>
    );
  if (preview.isPending)
    return (
      <Frame title="Lời mời">
        <p aria-busy="true" className="text-muted">
          Đang tải…
        </p>
      </Frame>
    );
  if (preview.isError) {
    const notFound = preview.error instanceof ORPCError && preview.error.code === "NOT_FOUND";
    return (
      <Frame title={notFound ? "Không tìm thấy lời mời" : "Không mở được lời mời"}>
        <Alert>{apiErrorMessage(preview.error)}</Alert>
        <HomeLink signedIn={me !== null} />
      </Frame>
    );
  }
  const invite = preview.data;
  if (invite.status === "accepted")
    return (
      <Frame title="Lời mời đã được dùng">
        <p className="text-muted">
          Lời mời vào <b className="text-ink">{invite.orgName}</b> cho {invite.email} đã được nhận. Mỗi link chỉ dùng
          được một lần. Nếu đó là bạn, đăng nhập để vào tổ chức; nếu không, nhờ quản trị tổ chức gửi lời mời mới.
        </p>
        <HomeLink signedIn={me !== null} />
      </Frame>
    );
  if (invite.status === "expired")
    return (
      <Frame title="Lời mời đã hết hạn">
        <p className="text-muted">
          Lời mời vào <b className="text-ink">{invite.orgName}</b> cho {invite.email} đã hết hạn ngày{" "}
          {formatDay(invite.expiresAt)}. Nhờ quản trị tổ chức gửi lời mời mới.
        </p>
        <HomeLink signedIn={me !== null} />
      </Frame>
    );

  return (
    <Frame title={`Lời mời vào ${invite.orgName}`}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg bg-subtle px-3.5 py-3 text-label">
        <dt className="text-muted">Tổ chức</dt>
        <dd className="font-medium text-ink">{invite.orgName}</dd>
        <dt className="text-muted">Email được mời</dt>
        <dd className="truncate font-medium text-ink">{invite.email}</dd>
        <dt className="text-muted">Hạn</dt>
        <dd className="text-ink">Dùng trước ngày {formatDay(invite.expiresAt)}, một lần</dd>
      </dl>
      {entering ? (
        <p aria-busy="true" className="text-muted">
          Đang vào {invite.orgName}…
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
  return signedIn ? (
    <Link to="/" className={buttonClass({ variant: "primary" })}>
      Về trang chủ
    </Link>
  ) : (
    <Link to="/dang-nhap" className={buttonClass({ variant: "primary" })}>
      Đăng nhập
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
        <p role="alert" className="rounded-lg bg-warn-bg px-3.5 py-2.5 text-label text-warn">
          Lời mời này dành cho <b>{invite.email}</b>, nhưng bạn đang đăng nhập bằng <b>{me.email}</b>. Đăng xuất rồi
          đăng nhập hoặc đăng ký bằng {invite.email} để nhận lời mời.
        </p>
        {signOut.isError && <Alert>Không đăng xuất được. Thử lại.</Alert>}
        <div className="flex justify-end gap-2">
          <Link to="/" className={buttonClass({ variant: "ghost" })}>
            Về trang chủ
          </Link>
          <Button variant="primary" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            <Icon name="logout" />
            {signOut.isPending ? "Đang đăng xuất…" : "Đăng xuất"}
          </Button>
        </div>
      </>
    );

  const busy = accept.isPending || accept.isSuccess;
  return (
    <>
      <p className="text-muted">
        Bạn đang đăng nhập bằng <span className="font-medium text-ink">{me.email}</span>. Nhận lời mời để vào{" "}
        {invite.orgName}.
      </p>
      {accept.isError && <Alert>{apiErrorMessage(accept.error)}</Alert>}
      <Button variant="primary" block disabled={busy} onClick={() => accept.mutate()}>
        {busy ? "Đang vào tổ chức…" : "Nhận lời mời và vào tổ chức"}
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
      name: name ? undefined : "Nhập họ và tên.",
      password: password.length >= MIN_PASSWORD ? undefined : `Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.`,
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
        <h2 className="text-lg font-semibold text-ink">Tạo tài khoản bằng email</h2>
        <Field invalid={errors.name !== undefined}>
          <FieldLabel>Họ và tên</FieldLabel>
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
            className="bg-subtle text-muted"
          />
        </Field>
        <Field invalid={errors.password !== undefined}>
          <FieldLabel>Mật khẩu</FieldLabel>
          <Input name="password" type="password" autoComplete="new-password" disabled={busy} />
          {errors.password ? (
            <FieldError>{errors.password}</FieldError>
          ) : (
            <FieldHint>Ít nhất {MIN_PASSWORD} ký tự.</FieldHint>
          )}
        </Field>
        {failure && <Alert>{failure}</Alert>}
        <Button type="submit" variant="primary" block disabled={busy}>
          <Icon name="mail" />
          {busy ? "Đang tạo tài khoản…" : "Tạo tài khoản và vào tổ chức"}
        </Button>
      </form>
      <div className="flex items-center gap-2.5 text-xs text-faint before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
        hoặc
      </div>
      <div className="grid gap-1.5">
        {/* Đăng nhập rồi quay lại đúng trang này để nhận lời mời; trang đăng nhập có đủ SSO, GitHub, GitLab, email. */}
        <Link to="/dang-nhap" search={{ redirect: `/moi/${token}` }} className={buttonClass({ block: true })}>
          <Icon name="key" />
          Đã có tài khoản: đăng nhập để nhận lời mời
        </Link>
        <small className="text-center text-xs text-muted">Đăng nhập bằng đúng {invite.email}.</small>
      </div>
    </>
  );
}
