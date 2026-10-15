import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { useState } from "react";
import { Brand } from "@/components/icons.tsx";
import { OnboardingSignOut } from "@/components/outside/onboarding-sign-out.tsx";
import { OutsideLayout } from "@/components/outside/outside-layout.tsx";
import { Card } from "@/components/ui/card.tsx";
import { authClient, oauthContinuation } from "@/lib/auth-client.ts";
import { type Dict, useT } from "@/lib/i18n.ts";

const bodyText: Dict<{ body: string }> = {
  vi: { body: "muốn gọi các tool MCP của hub thay bạn, với đúng quyền của bạn trong từng tổ chức." },
  en: { body: "wants to call the hub MCP tools on your behalf, with exactly your rights in each organization." },
};
const text: Dict<
  Record<"title" | "application" | "client" | "deny" | "allow" | "denying" | "allowing" | "failure", string>
> = {
  vi: {
    title: "Cho phép công cụ dùng hub?",
    application: "Một ứng dụng",
    client: "Mã client:",
    deny: "Từ chối",
    allow: "Cho phép",
    denying: "Đang từ chối…",
    allowing: "Đang cho phép…",
    failure: "Không gửi được câu trả lời cho hub. Yêu cầu có thể đã hết hạn; chạy lại lệnh đăng nhập trong CLI.",
  },
  en: {
    title: "Allow this tool to use the hub?",
    application: "An application",
    client: "Client ID:",
    deny: "Deny",
    allow: "Allow",
    denying: "Denying…",
    allowing: "Allowing…",
    failure: "Could not send your response to the hub. The request may have expired; sign in again from your CLI.",
  },
};

const scopeText = {
  vi: {
    openid: "Biết bạn là ai trên hub",
    profile: "Xem tên và ảnh đại diện",
    email: "Xem địa chỉ email",
    offline_access: "Giữ đăng nhập khi bạn không mở trình duyệt (làm mới token)",
  },
  en: {
    openid: "Know who you are on the hub",
    profile: "See your name and avatar",
    email: "See your email address",
    offline_access: "Stay signed in when your browser is closed (refresh token)",
  },
} satisfies Dict<Record<string, string>>;

/**
 * Trang đồng ý cho client MCP (Claude Code, Codex...) dùng hub thay bạn. Hub chuyển tới đây kèm query đã ký;
 * oauthProviderClient tự gửi lại query đó khi gọi /oauth2/consent, nên trang chỉ cần hỏi đồng ý hay không.
 */
export function McpConsentPage() {
  const t = { ...useT(text), ...useT(bodyText) };
  const scopeLabels: Record<string, string> = useT(scopeText);
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") ?? "";
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const [pending, setPending] = useState<"accept" | "deny" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function answer(accept: boolean) {
    setPending(accept ? "accept" : "deny");
    setFailure(null);
    try {
      const { data, error } = await authClient.$fetch("/oauth2/consent", { method: "POST", body: { accept } });
      const next = error ? null : oauthContinuation(data);
      if (next) {
        window.location.assign(next);
        return;
      }
    } catch {
      /* Hiện lỗi chung bên dưới. */
    }
    setFailure(t.failure);
    setPending(null);
  }

  let clientHost = clientId;
  try {
    clientHost = new URL(clientId).host;
  } catch {
    /* client_id không phải URL (client đăng ký tay); hiện nguyên chuỗi. */
  }

  return (
    <OutsideLayout header={<OnboardingSignOut />}>
      <Card className="grid w-full max-w-105 gap-5 p-6 sm:p-8 shadow-lg">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-11 place-items-center rounded-lg border border-border font-mono text-xl"
          >
            &gt;_
          </span>
          <span aria-hidden="true" className="w-8 border-t border-dashed border-muted-foreground" />
          <Brand />
        </div>
        <h1 className="mt-1 font-heading text-xl font-semibold text-foreground">{t.title}</h1>
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground break-all">{clientHost || t.application}</span> {t.body}
        </p>
        {scopes.length > 0 && (
          <ul className="grid divide-y divide-border overflow-hidden rounded-lg border border-border">
            {scopes.map((s) => (
              <li key={s} className="flex items-start gap-2.5 px-3 py-2.5">
                <span
                  aria-hidden="true"
                  className="grid size-5 shrink-0 place-items-center rounded-full bg-success-soft text-success"
                >
                  ✓
                </span>
                <span className="min-w-0 break-words">{scopeLabels[s] ?? s}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="font-mono text-xs text-muted-foreground break-all">
          {t.client} {clientId}
        </p>
        {failure && <Alert variant="destructive">{failure}</Alert>}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" disabled={pending !== null} onClick={() => answer(false)}>
            {pending === "deny" ? t.denying : t.deny}
          </Button>
          <Button variant="default" disabled={pending !== null} onClick={() => answer(true)}>
            {pending === "accept" ? t.allowing : t.allow}
          </Button>
        </div>
      </Card>
    </OutsideLayout>
  );
}
