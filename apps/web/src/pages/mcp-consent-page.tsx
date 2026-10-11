import { useState } from "react";
import { Brand } from "../components/icons.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { authClient, oauthContinuation } from "../lib/auth-client.ts";

const SCOPE_LABELS: Record<string, string> = {
  openid: "Biết bạn là ai trên hub",
  profile: "Xem tên và ảnh đại diện",
  email: "Xem địa chỉ email",
  offline_access: "Giữ đăng nhập khi bạn không mở trình duyệt (làm mới token)",
};

/**
 * Trang đồng ý cho client MCP (Claude Code, Codex...) dùng hub thay bạn. Hub chuyển tới đây kèm query đã ký;
 * oauthProviderClient tự gửi lại query đó khi gọi /oauth2/consent, nên trang chỉ cần hỏi đồng ý hay không.
 */
export function McpConsentPage() {
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
    setFailure("Không gửi được câu trả lời cho hub. Yêu cầu có thể đã hết hạn; chạy lại lệnh đăng nhập trong CLI.");
    setPending(null);
  }

  let clientHost = clientId;
  try {
    clientHost = new URL(clientId).host;
  } catch {
    /* client_id không phải URL (client đăng ký tay); hiện nguyên chuỗi. */
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-6">
      <Card className="grid w-full max-w-105 gap-4 p-7">
        <Brand />
        <h1 className="mt-1 text-3xl font-bold text-ink">Cho phép công cụ dùng hub?</h1>
        <p className="text-muted">
          <span className="font-medium text-ink">{clientHost || "Một ứng dụng"}</span> muốn gọi các tool MCP của hub
          thay bạn, với đúng quyền của bạn trong từng tổ chức.
        </p>
        {scopes.length > 0 && (
          <ul className="grid list-disc gap-1 pl-5 text-sm text-muted">
            {scopes.map((s) => (
              <li key={s}>{SCOPE_LABELS[s] ?? s}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-faint break-all">Mã client: {clientId}</p>
        {failure && <Alert>{failure}</Alert>}
        <div className="grid grid-cols-2 gap-2">
          <Button disabled={pending !== null} onClick={() => answer(false)}>
            {pending === "deny" ? "Đang từ chối…" : "Từ chối"}
          </Button>
          <Button variant="primary" disabled={pending !== null} onClick={() => answer(true)}>
            {pending === "accept" ? "Đang cho phép…" : "Cho phép"}
          </Button>
        </div>
      </Card>
    </main>
  );
}
