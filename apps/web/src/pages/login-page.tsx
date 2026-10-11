import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Brand, Icon } from "../components/icons.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Field, FieldError, FieldHint, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import { authClient, oauthContinuation } from "../lib/auth-client.ts";
import { type AuthErrorLike, type AuthMethod, authErrorLabel } from "../lib/auth-errors.ts";
import { meQuery } from "../lib/me.ts";
import { emailDomain } from "../lib/people.ts";
import { loginHref, safeRedirect } from "../lib/redirect.ts";

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

type Pending = "sso" | "github" | "gitlab" | "email";
/** Lỗi hiện ngay cạnh cách đăng nhập vừa dùng; `redirect` là lỗi hub gửi về qua `?error=`. */
type Failure = { at: AuthMethod | "redirect"; message: string };

const methodOf = (p: Pending): AuthMethod => (p === "github" || p === "gitlab" ? "social" : p);

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
    setFailure({ at: methodOf(kind), message: authErrorLabel(error, methodOf(kind)) });
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

  const busy = pending !== null;
  const errorAt = (at: Failure["at"]) => (failure?.at === at ? failure.message : null);

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-6">
      <Card className="grid w-full max-w-105 gap-4 p-7">
        <Brand />
        <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight text-ink">Đăng nhập</h1>
        <p className="-mt-2 text-muted">Dùng tài khoản công ty, GitHub, GitLab hoặc email.</p>
        {errorAt("redirect") && <Alert>{errorAt("redirect")}</Alert>}

        <Field render={<form noValidate onSubmit={onSso} />} invalid={errorAt("sso") !== null}>
          <FieldLabel>Email công ty</FieldLabel>
          <Input name="email" type="email" autoComplete="email" placeholder="ten@congty.vn" />
          {errorAt("sso") ? (
            <FieldError>{errorAt("sso")}</FieldError>
          ) : (
            <FieldHint>Hub tìm SSO của tổ chức theo tên miền email.</FieldHint>
          )}
          <Button type="submit" variant="primary" block disabled={busy}>
            <Icon name="key" />
            {pending === "sso" ? "Đang chuyển sang SSO…" : "Tiếp tục với SSO"}
          </Button>
        </Field>

        <div className="flex items-center gap-2.5 text-xs text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
          hoặc
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            disabled={busy}
            onClick={() => attempt("github", () => authClient.signIn.social({ provider: "github", ...callbacks }))}
          >
            <Icon name="github" />
            {pending === "github" ? "Đang chuyển…" : "GitHub"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => attempt("gitlab", () => authClient.signIn.social({ provider: "gitlab", ...callbacks }))}
          >
            <Icon name="gitlab" />
            {pending === "gitlab" ? "Đang chuyển…" : "GitLab"}
          </Button>
        </div>
        {errorAt("social") && <Alert>{errorAt("social")}</Alert>}

        <details>
          <summary className="cursor-pointer text-label text-muted">Đăng nhập bằng email và mật khẩu</summary>
          <form noValidate onSubmit={onEmail} className="mt-3 grid gap-2.5">
            <Field>
              <FieldLabel>Email</FieldLabel>
              <Input name="email" type="email" autoComplete="username" />
            </Field>
            <Field>
              <FieldLabel>Mật khẩu</FieldLabel>
              <Input name="password" type="password" autoComplete="current-password" />
            </Field>
            {errorAt("email") && <Alert>{errorAt("email")}</Alert>}
            <Button type="submit" block disabled={busy}>
              <Icon name="mail" />
              {pending === "email" ? "Đang đăng nhập…" : "Đăng nhập"}
            </Button>
          </form>
        </details>

        {/* Mockup giữ lề mặc định của <p> (1em) quanh dòng này. */}
        <p className="my-3 text-center text-xs text-muted">Chưa có tài khoản? Nhờ quản trị tổ chức gửi lời mời.</p>
      </Card>
    </main>
  );
}
