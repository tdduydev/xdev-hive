import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { Textarea } from "@xdev-hive/ui/textarea";
import { CircleCheckIcon, LoaderCircleIcon } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { LangToggle } from "@/components/lang-toggle.tsx";
import { Wordmark } from "@/components/logo.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { askNotificationPermission, browserLogin, errorText, parseRegistration, registerWorker } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  title: string;
  lead: string;
  hub: string;
  token: string;
  paste: string;
  cmdLabel: string;
  fill: string;
  tokenHint: string;
  submit: string;
  foot: string;
  parsed: string;
  busy: string;
  doneTitle: string;
  browser: string;
  browserHint: string;
  browserBusy: string;
  manual: string;
}> = {
  vi: {
    title: "Kết nối máy của bạn",
    lead: "Đăng ký một lần để worker nhận việc từ đội của bạn.",
    hub: "Địa chỉ hub công khai",
    token: "Token đăng ký",
    paste: "Hoặc dán lệnh đăng ký",
    cmdLabel: "Lệnh do admin đội cung cấp",
    fill: "Điền từ lệnh",
    tokenHint: "Token dùng một lần và hết hạn sau 1 giờ. Xin token từ admin đội trên web.",
    submit: "Đăng ký và bật worker",
    foot: "Đóng cửa sổ để ẩn vào khay. Worker vẫn chạy nền.",
    parsed: "Đã điền địa chỉ hub và token.",
    busy: "Đang đăng ký máy…",
    doneTitle: "Đã đăng ký. Worker đang kết nối với hub.",
    browser: "Đăng nhập bằng trình duyệt",
    browserHint: "Mở trang đăng nhập của hub; đăng nhập rồi bấm Cho phép, app tự đăng ký máy và liên kết tài khoản.",
    browserBusy: "Đang chờ bạn đăng nhập trên trình duyệt…",
    manual: "Hoặc nhập token đăng ký",
  },
  en: {
    title: "Connect your machine",
    lead: "Register once so the worker can take tasks from your team.",
    hub: "Public hub address",
    token: "Registration token",
    paste: "Or paste the registration command",
    cmdLabel: "Command from your team admin",
    fill: "Fill from command",
    tokenHint: "Tokens work once and expire after 1 hour. Ask your team admin on the web.",
    submit: "Register and start worker",
    foot: "Close the window to hide it in the tray. The worker keeps running.",
    parsed: "Filled in the hub address and token.",
    busy: "Registering this machine…",
    doneTitle: "Registered. The worker is connecting to the hub.",
    browser: "Sign in with browser",
    browserHint:
      "Opens the hub sign-in page; sign in and press Allow, then the app registers this machine and links your account.",
    browserBusy: "Waiting for you to sign in in the browser…",
    manual: "Or enter a registration token",
  },
};

/** Năm trạng thái của AppRegister.dc.html: mới mở, đã dán lệnh, đang đăng ký, lỗi, đã đăng ký. */
type Status = { kind: "empty" | "parsed" | "busy" | "browser" | "done" } | { kind: "error"; message: string };

/**
 * Cửa sổ đăng ký máy (AppRegister.dc.html). Token chỉ nằm trong state của form và bị xoá ngay sau khi gửi; Rust
 * chuyển nó cho sidecar qua biến môi trường chứ không qua tham số dòng lệnh.
 */
export function RegisterScreen() {
  const t = useT(text);
  const [hub, setHub] = useState("");
  const [token, setToken] = useState("");
  const [command, setCommand] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "empty" });

  useEffect(() => {
    void askNotificationPermission();
  }, []);

  async function fill() {
    try {
      const parsed = await parseRegistration(command);
      setHub(parsed.hub);
      setToken(parsed.token);
      setCommand("");
      setStatus({ kind: "parsed" });
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    }
  }

  async function signIn() {
    setStatus({ kind: "browser" });
    try {
      await browserLogin(hub.trim());
      setStatus({ kind: "done" });
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStatus({ kind: "busy" });
    try {
      await registerWorker(hub.trim(), token.trim());
      setToken("");
      setCommand("");
      setStatus({ kind: "done" });
    } catch (error) {
      setStatus({ kind: "error", message: errorText(error) });
    }
  }

  const busy = status.kind === "busy" || status.kind === "browser";
  const message =
    status.kind === "error"
      ? status.message
      : status.kind === "parsed"
        ? t.parsed
        : status.kind === "busy"
          ? t.busy
          : status.kind === "browser"
            ? t.browserBusy
            : null;

  return (
    <main className="flex min-h-svh flex-col gap-[18px] bg-card p-7 text-card-foreground">
      <div className="flex items-center justify-between gap-3">
        <Wordmark />
        <LangToggle />
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-[22px] font-semibold tracking-tight">{t.title}</h1>
        <p className="text-muted-foreground">{t.lead}</p>
      </div>

      {status.kind === "done" ? (
        <div role="status" className="flex items-start gap-3 rounded-lg bg-success-soft p-4 text-success">
          <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <strong>{t.doneTitle}</strong>
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hub">{t.hub}</Label>
            <Input
              id="hub"
              type="url"
              required
              autoComplete="url"
              placeholder="https://hive.cong-ty.vn"
              className="font-mono text-sm md:text-sm"
              value={hub}
              onChange={(e) => setHub(e.target.value)}
            />
          </div>
          <Button type="button" disabled={busy || !hub.trim()} onClick={signIn}>
            {status.kind === "browser" && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
            {t.browser}
          </Button>
          <p className="text-sm text-muted-foreground">{t.browserHint}</p>
          <details className="rounded-lg border px-3 py-2.5">
            <summary className="cursor-pointer text-sm font-medium">{t.manual}</summary>
            <div className="mt-2.5 flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="token">{t.token}</Label>
                <Input
                  id="token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-sm md:text-sm"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
              <details
                open={pasteOpen}
                onToggle={(e) => setPasteOpen(e.currentTarget.open)}
                className="rounded-lg border border-dashed px-3 py-2.5"
              >
                <summary className="cursor-pointer text-sm font-medium">{t.paste}</summary>
                <div className="mt-2.5 flex flex-col gap-2">
                  <Label htmlFor="command">{t.cmdLabel}</Label>
                  <Textarea
                    id="command"
                    rows={3}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="hive-worker register --hub … --token …"
                    className="resize-none font-mono text-xs"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                  />
                  <Button type="button" variant="secondary" size="sm" className="self-start" onClick={fill}>
                    {t.fill}
                  </Button>
                </div>
              </details>
              <p className="text-sm text-muted-foreground">{t.tokenHint}</p>
              <Button type="submit" variant="secondary" disabled={busy || !token.trim()}>
                {status.kind === "busy" && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
                {t.submit}
              </Button>
            </div>
          </details>
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "min-h-5 text-sm",
              status.kind === "error" && "text-destructive",
              status.kind === "parsed" && "text-success",
              status.kind === "busy" && "text-muted-foreground",
            )}
          >
            {message}
          </p>
        </form>
      )}
      <p className="mt-auto border-t pt-3 text-center text-xs text-muted-foreground">{t.foot}</p>
    </main>
  );
}
