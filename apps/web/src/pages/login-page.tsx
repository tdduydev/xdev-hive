import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { GitPullRequestIcon, ShieldCheckIcon, SquareTerminalIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Brand, Icon } from "@/components/icons.tsx";
import { Card } from "@/components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";
import { authClient, oauthContinuation } from "@/lib/auth-client.ts";
import { type AuthErrorLike, type AuthMethod, authErrorLabel } from "@/lib/auth-errors.ts";
import { meQuery } from "@/lib/me.ts";
import { emailDomain } from "@/lib/people.ts";
import { loginHref, safeRedirect } from "@/lib/redirect.ts";
import { orpc } from "@/lib/rpc.ts";

export interface LoginSearch {
  /** Trang muốn vào trước khi bị chuyển về đây. */
  redirect?: string;
  /** Mã lỗi Better Auth gắn vào khi chuyển hướng về sau OAuth/SSO. */
  error?: string;
}

export function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  return {
    ...(typeof search.redirect === "string" ? { redirect: search.redirect } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  };
}

type Pending = "sso" | "github" | "gitlab" | "email" | "signup";
/** Lỗi hiện ngay cạnh cách đăng nhập vừa dùng; `redirect` là lỗi hub gửi về qua `?error=`. */
type Failure = { at: AuthMethod | "redirect"; message: string };

const methodOf = (p: Pending): AuthMethod => (p === "github" || p === "gitlab" ? "social" : p);

const MIN_PASSWORD = 10;

/** Màn 1 của mockup: SSO trên cùng, rồi GitHub/GitLab, email + mật khẩu nằm trong phần mở thêm. */
export function LoginPage() {
  const search = useSearch({ from: "/login" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const target = safeRedirect(search.redirect);
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(() =>
    search.error ? { at: "redirect", message: authErrorLabel({ code: search.error }) } : null,
  );
  // Hub chưa có tổ chức nào: người quản trị hub tạo tài khoản ngay tại đây thay cho lệnh curl trong tài liệu.
  const setup = useQuery({ ...orpc.hubSetup.get.queryOptions(), staleTime: 60_000, retry: false });
  const firstAdmin = setup.data?.firstAdminSignUp === true;

  // Bấm Back từ trang GitHub/IdP, trình duyệt có thể khôi phục trang từ bfcache với nút còn khoá; mở khoá lại.
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => e.persisted && setPending(null);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  // Đường dẫn tương đối: hub phân giải theo HIVE_PUBLIC_URL, nên cùng origin với web.
  const callbacks = { callbackURL: target, errorCallbackURL: loginHref(target) };

  /** Gọi Better Auth; true nếu thành công. Với SSO và OAuth, authClient tự chuyển trình duyệt sang nhà cung cấp. */
  async function attempt(
    kind: Pending,
    call: () => Promise<{ data?: unknown; error: AuthErrorLike | null }>,
  ): Promise<boolean> {
    setPending(kind);
    setFailure(null);
    let error: AuthErrorLike | null;
    let data: unknown;
    try {
      ({ data, error } = await call());
    } catch {
      error = { status: 0 };
    }
    // Đang đăng nhập cho client MCP (CLI): hub trả bước kế tiếp của luồng authorize thay vì về trang của web.
    const next = error ? null : oauthContinuation(data);
    if (next) {
      window.location.assign(next);
      return false;
    }
    if (!error) return true;
    // Hub dùng một mã cho mọi lần từ chối (không lộ email nào được tạo); ở form quản trị đầu tiên thì câu "mở link mời"
    // không đúng ngữ cảnh.
    const message =
      kind === "signup" && error.code === "SIGN_UP_INVITE_REQUIRED"
        ? "Không tạo được tài khoản quản trị bằng email này. Dùng đúng email đã khai khi cài hub, hoặc đăng nhập nếu đã có tài khoản."
        : authErrorLabel(error, methodOf(kind));
    setFailure({ at: methodOf(kind), message });
    setPending(null);
    return false;
  }

  async function onSso(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    const domain = emailDomain(email);
    if (!domain) {
      setFailure({ at: "sso", message: "Nhập email công ty, ví dụ ten@congty.vn." });
      return;
    }
    await attempt("sso", () => authClient.signIn.sso({ domain, loginHint: email, ...callbacks }));
  }

  async function onEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!email || !password) {
      setFailure({ at: "email", message: "Nhập email và mật khẩu." });
      return;
    }
    if (await attempt("email", () => authClient.signIn.email({ email, password }))) {
      // Cookie phiên vừa được đặt; bỏ kết quả "chưa đăng nhập" cũ để guard hỏi lại hub.
      queryClient.removeQueries({ queryKey: meQuery.queryKey });
      await navigate({ href: target, replace: true });
    }
  }

  async function onFirstAdmin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!name || !email || !password) {
      setFailure({ at: "signup", message: "Nhập tên, email và mật khẩu." });
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setFailure({ at: "signup", message: `Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự.` });
      return;
    }
    if (await attempt("signup", () => authClient.signUp.email({ name, email, password }))) {
      queryClient.removeQueries({ queryKey: meQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: orpc.hubSetup.get.key() });
      await navigate({ href: target, replace: true });
    }
  }

  const busy = pending !== null;
  const errorAt = (at: Failure["at"]) => (failure?.at === at ? failure.message : null);

  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex items-center justify-center px-4 py-6 md:p-10">
        <Card className="grid w-full max-w-105 gap-4 p-7">
          <Brand />
          <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight text-foreground">Đăng nhập</h1>
          <p className="-mt-2 text-muted-foreground">Dùng tài khoản công ty, GitHub, GitLab hoặc email.</p>
          {errorAt("redirect") && <Alert variant="destructive">{errorAt("redirect")}</Alert>}

          {firstAdmin && (
            <section
              aria-labelledby="first-admin"
              className="grid gap-2.5 rounded-lg border border-primary/40 bg-accent p-4"
            >
              <h2 id="first-admin" className="text-sm font-semibold text-accent-foreground">
                Tạo tài khoản quản trị đầu tiên
              </h2>
              <p className="text-xs text-foreground">
                Hub chưa có tổ chức nào. Chỉ người quản trị hub (email khai lúc cài hub) mới tạo được tài khoản ở đây;
                sau khi có tổ chức, mọi người vào bằng lời mời.
              </p>
              <form noValidate onSubmit={onFirstAdmin} className="grid gap-2.5">
                <Field>
                  <FieldLabel>Tên hiển thị</FieldLabel>
                  <Input name="name" autoComplete="name" />
                </Field>
                <Field>
                  <FieldLabel>Email</FieldLabel>
                  <Input name="email" type="email" autoComplete="email" />
                </Field>
                <Field>
                  <FieldLabel>Mật khẩu</FieldLabel>
                  <Input name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} />
                  <FieldHint>Ít nhất {MIN_PASSWORD} ký tự.</FieldHint>
                </Field>
                {errorAt("signup") && <Alert variant="destructive">{errorAt("signup")}</Alert>}
                <Button type="submit" variant="default" className="w-full" disabled={busy}>
                  <Icon name="key" />
                  {pending === "signup" ? "Đang tạo tài khoản…" : "Tạo tài khoản quản trị"}
                </Button>
              </form>
            </section>
          )}

          <Field render={<form noValidate onSubmit={onSso} />} invalid={errorAt("sso") !== null}>
            <FieldLabel>Email công ty</FieldLabel>
            <Input name="email" type="email" autoComplete="email" placeholder="ten@congty.vn" />
            {errorAt("sso") ? (
              <FieldError>{errorAt("sso")}</FieldError>
            ) : (
              <FieldHint>Hub tìm SSO của tổ chức theo tên miền email.</FieldHint>
            )}
            <Button type="submit" variant="default" className="w-full" disabled={busy}>
              <Icon name="key" />
              {pending === "sso" ? "Đang chuyển sang SSO…" : "Tiếp tục với SSO"}
            </Button>
          </Field>

          <div className="flex items-center gap-2.5 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            hoặc
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => attempt("github", () => authClient.signIn.social({ provider: "github", ...callbacks }))}
            >
              <Icon name="github" />
              {pending === "github" ? "Đang chuyển…" : "GitHub"}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => attempt("gitlab", () => authClient.signIn.social({ provider: "gitlab", ...callbacks }))}
            >
              <Icon name="gitlab" />
              {pending === "gitlab" ? "Đang chuyển…" : "GitLab"}
            </Button>
          </div>
          {errorAt("social") && <Alert variant="destructive">{errorAt("social")}</Alert>}

          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">Đăng nhập bằng email và mật khẩu</summary>
            <form noValidate onSubmit={onEmail} className="mt-3 grid gap-2.5">
              <Field>
                <FieldLabel>Email</FieldLabel>
                <Input name="email" type="email" autoComplete="username" />
              </Field>
              <Field>
                <FieldLabel>Mật khẩu</FieldLabel>
                <Input name="password" type="password" autoComplete="current-password" />
              </Field>
              {errorAt("email") && <Alert variant="destructive">{errorAt("email")}</Alert>}
              <Button variant="outline" type="submit" className="w-full" disabled={busy}>
                <Icon name="mail" />
                {pending === "email" ? "Đang đăng nhập…" : "Đăng nhập"}
              </Button>
            </form>
          </details>

          {/* Mockup giữ lề mặc định của <p> (1em) quanh dòng này. */}
          <p className="my-3 text-center text-xs text-muted-foreground">
            Chưa có tài khoản? Nhờ quản trị tổ chức gửi lời mời.
          </p>
        </Card>
      </div>
      <LoginShowcase />
    </main>
  );
}

const SHOWCASE: { icon: typeof ShieldCheckIcon; text: string }[] = [
  {
    icon: SquareTerminalIcon,
    text: "Claude Code, Codex, Gemini CLI chạy trên máy của đội với tài khoản đã đăng nhập sẵn; hub không giữ thông tin đăng nhập của CLI.",
  },
  {
    icon: GitPullRequestIcon,
    text: "Mỗi việc thành một pull request, có review chéo và hàng merge theo cấu hình dự án.",
  },
  {
    icon: ShieldCheckIcon,
    text: "Dự án cần cách ly chạy trong sandbox gVisor, chỉ ra được các địa chỉ trong allowlist.",
  },
];

/** Cột giới thiệu bên phải màn đăng nhập trên màn hình rộng; điện thoại chỉ thấy form. */
function LoginShowcase() {
  return (
    <section
      aria-label="Giới thiệu xDev Hive"
      className="hidden flex-col justify-between gap-10 border-l border-border bg-muted/50 p-10 lg:flex"
    >
      <span className="font-mono text-xs tracking-caps text-muted-foreground uppercase">xDev Hive · tự host</span>
      <div className="grid max-w-lg gap-8">
        <p className="font-heading text-3xl leading-tight font-semibold tracking-tight text-foreground">
          Giao việc cho agent, giữ code và tài khoản trên máy của đội.
        </p>
        <ul className="grid gap-4">
          {SHOWCASE.map(({ icon: IconComponent, text }) => (
            <li key={text} className="flex gap-3 text-sm text-muted-foreground">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-background text-primary ring-1 ring-foreground/10">
                <IconComponent className="size-4" aria-hidden="true" />
              </span>
              <span className="pt-1.5">{text}</span>
            </li>
          ))}
        </ul>
      </div>
      <span className="text-xs text-muted-foreground">Mã nguồn mở, giấy phép AGPL-3.0.</span>
    </section>
  );
}
