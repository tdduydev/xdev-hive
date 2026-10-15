import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { Textarea } from "@xdev-hive/ui/textarea";
import { CircleCheckIcon, LoaderCircleIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { type AccountStatus, accountBrowserLogin, accountStatus, linkAccount } from "@/lib/account.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import {
  browserLogin,
  errorText,
  hubChange,
  hubCheck,
  parseRegistration,
  registerWorker,
  sameHub,
} from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{
  hub: string;
  token: string;
  paste: string;
  cmdLabel: string;
  fill: string;
  tokenHint: string;
  submit: string;
  parsed: string;
  busy: string;
  checking: string;
  doneTitle: string;
  signedIn: string;
  moved: (hub: string) => string;
  browser: string;
  browserHint: string;
  signInHint: string;
  browserBusy: string;
  manual: string;
  change: string;
  pat: string;
  patLabel: string;
  patHint: string;
  patSubmit: string;
  patBusy: string;
  confirmTitle: string;
  confirmBody: (hub: string) => string;
  confirmYes: string;
  cancel: string;
}> = {
  vi: {
    hub: "Địa chỉ Hive",
    token: "Token đăng ký",
    paste: "Hoặc dán lệnh đăng ký",
    cmdLabel: "Lệnh do admin đội cung cấp",
    fill: "Điền từ lệnh",
    tokenHint: "Token dùng một lần và hết hạn sau 1 giờ. Xin token từ admin đội trên web.",
    submit: "Đăng ký và bật worker",
    parsed: "Đã điền địa chỉ hub và token.",
    busy: "Đang đăng ký máy…",
    checking: "Đang kiểm địa chỉ hub…",
    doneTitle: "Đã đăng ký. Worker đang kết nối với hub.",
    signedIn: "Đã đăng nhập.",
    moved: (hub) => `Đã chuyển máy sang ${hub}. Worker đang kết nối lại.`,
    browser: "Đăng nhập bằng trình duyệt",
    browserHint: "Mở trang đăng nhập của hub; đăng nhập rồi bấm Cho phép, app tự đăng ký máy và liên kết tài khoản.",
    signInHint:
      "Mở trang đăng nhập của hub; đăng nhập rồi bấm Cho phép. Máy đã đăng ký nên không phải chọn đội hay đăng ký lại.",
    browserBusy: "Đang chờ bạn đăng nhập trên trình duyệt…",
    manual: "Hoặc nhập token đăng ký",
    change: "Đổi địa chỉ",
    pat: "Hoặc dùng token MCP cá nhân",
    patLabel: "Token MCP cá nhân",
    patHint:
      "Tạo ở web: MCP và công cụ → Token MCP → Tạo token. Token lưu trong keychain của máy, không ghi ra file và không gửi đi đâu ngoài hub.",
    patSubmit: "Đăng nhập",
    patBusy: "Đang kiểm token…",
    confirmTitle: "Đăng ký lại máy với hub mới?",
    confirmBody: (hub) =>
      `${hub} không nhận đăng ký cũ của máy này (hub khác, hoặc máy đã bị gỡ). Đăng ký lại thì worker nhận việc từ hub mới. Gói agent, dự án, tài khoản CLI và tài liệu trên máy giữ nguyên.`,
    confirmYes: "Đăng ký lại và đăng nhập",
    cancel: "Huỷ",
  },
  en: {
    hub: "Hive address",
    token: "Registration token",
    paste: "Or paste the registration command",
    cmdLabel: "Command from your team admin",
    fill: "Fill from command",
    tokenHint: "Tokens work once and expire after 1 hour. Ask your team admin on the web.",
    submit: "Register and start worker",
    parsed: "Filled in the hub address and token.",
    busy: "Registering this machine…",
    checking: "Checking the hub address…",
    doneTitle: "Registered. The worker is connecting to the hub.",
    signedIn: "Signed in.",
    moved: (hub) => `Moved this machine to ${hub}. The worker is reconnecting.`,
    browser: "Sign in with browser",
    browserHint:
      "Opens the hub sign-in page; sign in and press Allow, then the app registers this machine and links your account.",
    signInHint:
      "Opens the hub sign-in page; sign in and press Allow. This machine is already registered, so there is no team to pick.",
    browserBusy: "Waiting for you to sign in in the browser…",
    manual: "Or enter a registration token",
    change: "Change address",
    pat: "Or use a personal MCP token",
    patLabel: "Personal MCP token",
    patHint:
      "Create one on the web: MCP & tools → MCP tokens → Create token. The token stays in this machine's keychain, never in a file, and goes nowhere but the hub.",
    patSubmit: "Sign in",
    patBusy: "Checking the token…",
    confirmTitle: "Register this machine with the new hub?",
    confirmBody: (hub) =>
      `${hub} does not accept this machine's registration (a different hub, or the machine was removed). Registering again makes the worker take runs from the new hub. Agent plans, projects, CLI accounts and docs on this machine stay as they are.`,
    confirmYes: "Register again and sign in",
    cancel: "Cancel",
  },
};

type Status =
  | { kind: "empty" | "parsed" | "busy" | "checking" | "browser" | "linking" | "done" | "signedIn" }
  | { kind: "moved"; hub: string }
  | { kind: "confirm"; hub: string }
  | { kind: "error"; message: string };

/**
 * Kết nối với Hive: dùng ở cửa sổ đăng ký và hộp thoại Tài khoản, để người chưa kết nối hay vừa đăng xuất không phải
 * rời giao diện chính. Ô địa chỉ luôn sửa được và điền sẵn hub đang lưu, vì hub có thể dời địa chỉ (http sang https,
 * bỏ cổng cũ): địa chỉ mới được kiểm trước, máy chỉ đăng ký lại khi hub mới không nhận đăng ký cũ và người dùng đồng ý.
 * Token chỉ nằm trong state của form và bị xoá ngay sau khi gửi; Rust chuyển token đăng ký cho sidecar qua biến môi
 * trường chứ không qua tham số dòng lệnh.
 */
export function ConnectForm({
  current = null,
  linked = false,
  onDone,
}: {
  /** Hub máy đang đăng ký; null là máy chưa đăng ký. */
  current?: string | null;
  /** Đã đăng nhập trên hub đang lưu: chỉ còn việc đổi địa chỉ. */
  linked?: boolean;
  /** Xong một bước; có trạng thái tài khoản mới thì kèm theo. */
  onDone?: (status?: AccountStatus) => void;
}) {
  const t = useT(text);
  const id = useId();
  const [hub, setHub] = useState(current ?? "");
  const [token, setToken] = useState("");
  const [pat, setPat] = useState("");
  const [command, setCommand] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "empty" });

  // Hub đang lưu đổi (đổi địa chỉ xong, đăng ký ở cửa sổ khác) thì ô địa chỉ theo.
  useEffect(() => setHub(current ?? ""), [current]);

  const target = hub.trim();
  const moving = !!current && !!target && !sameHub(target, current);
  const registered = !!current;

  function fail(error: unknown) {
    setStatus({ kind: "error", message: errorText(error) });
  }

  async function fill() {
    try {
      const parsed = await parseRegistration(command);
      setHub(parsed.hub);
      setToken(parsed.token);
      setCommand("");
      setStatus({ kind: "parsed" });
    } catch (error) {
      fail(error);
    }
  }

  /**
   * Đưa máy đã đăng ký sang địa chỉ đang nhập. Trả địa chỉ mới, hoặc null khi hub mới cần đăng ký lại (đã chuyển sang
   * bước hỏi người dùng).
   */
  async function moveTo(address: string): Promise<string | null> {
    const change = await hubChange(address);
    if (change.needsRegister) {
      setStatus({ kind: "confirm", hub: change.hub });
      return null;
    }
    return change.hub;
  }

  async function register(address: string) {
    setStatus({ kind: "browser" });
    await browserLogin(address);
    setStatus({ kind: "done" });
    onDone?.();
  }

  async function signIn() {
    setStatus({ kind: "checking" });
    try {
      const address = await hubCheck(target);
      if (!registered) return await register(address);
      if (moving) {
        const moved = await moveTo(address);
        if (!moved) return;
        // Token cá nhân đi theo khi hub mới nhận nó; còn dùng được thì khỏi mở trình duyệt.
        const after = await accountStatus();
        if (after.account) {
          setStatus({ kind: "moved", hub: moved });
          return onDone?.(after);
        }
      }
      setStatus({ kind: "browser" });
      const signed = await accountBrowserLogin();
      setStatus({ kind: "signedIn" });
      onDone?.(signed);
    } catch (error) {
      fail(error);
    }
  }

  async function change() {
    setStatus({ kind: "checking" });
    try {
      const moved = await moveTo(await hubCheck(target));
      if (!moved) return;
      setStatus({ kind: "moved", hub: moved });
      onDone?.(await accountStatus());
    } catch (error) {
      fail(error);
    }
  }

  async function reregister() {
    if (status.kind !== "confirm") return;
    try {
      await register(status.hub);
    } catch (error) {
      fail(error);
    }
  }

  async function submitPat(event: FormEvent) {
    event.preventDefault();
    setStatus({ kind: "checking" });
    try {
      if (moving && !(await moveTo(await hubCheck(target)))) return;
      setStatus({ kind: "linking" });
      const signed = await linkAccount(pat);
      setPat("");
      setStatus({ kind: "signedIn" });
      onDone?.(signed);
    } catch (error) {
      fail(error);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = status.kind === "confirm" ? status.hub : target;
    setStatus({ kind: "checking" });
    try {
      const checked = await hubCheck(address);
      setStatus({ kind: "busy" });
      await registerWorker(checked, token.trim());
      setToken("");
      setCommand("");
      setStatus({ kind: "done" });
      onDone?.();
    } catch (error) {
      fail(error);
    }
  }

  const busy = ["busy", "checking", "browser", "linking"].includes(status.kind);
  const confirming = status.kind === "confirm";
  const message =
    status.kind === "error"
      ? status.message
      : status.kind === "parsed"
        ? t.parsed
        : status.kind === "busy"
          ? t.busy
          : status.kind === "checking"
            ? t.checking
            : status.kind === "browser"
              ? t.browserBusy
              : status.kind === "linking"
                ? t.patBusy
                : status.kind === "signedIn"
                  ? t.signedIn
                  : status.kind === "moved"
                    ? t.moved(status.hub)
                    : null;

  if (status.kind === "done")
    return (
      <div role="status" className="flex items-start gap-3 rounded-lg bg-success-soft p-4 text-success">
        <CircleCheckIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <strong>{t.doneTitle}</strong>
      </div>
    );

  const registerToken = (
    <details className="rounded-lg border px-3 py-2.5">
      <summary className="cursor-pointer text-sm font-medium">{t.manual}</summary>
      <form onSubmit={submit} className="mt-2.5 flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-token`}>{t.token}</Label>
          <Input
            id={`${id}-token`}
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
            <Label htmlFor={`${id}-command`}>{t.cmdLabel}</Label>
            <Textarea
              id={`${id}-command`}
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
        <Button type="submit" variant="secondary" disabled={busy || !token.trim() || !target}>
          {status.kind === "busy" && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          {t.submit}
        </Button>
      </form>
    </details>
  );

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-hub`}>{t.hub}</Label>
        <Input
          id={`${id}-hub`}
          type="url"
          required
          autoComplete="url"
          placeholder="https://hive.cong-ty.vn"
          className="font-mono text-sm md:text-sm"
          value={hub}
          disabled={confirming}
          onChange={(e) => {
            setHub(e.target.value);
            if (status.kind !== "empty" && !busy) setStatus({ kind: "empty" });
          }}
        />
      </div>
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft p-3 text-sm">
          <strong>{t.confirmTitle}</strong>
          <p>{t.confirmBody(status.hub)}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={reregister}>
              {t.confirmYes}
            </Button>
            <Button type="button" variant="outline" onClick={() => setStatus({ kind: "empty" })}>
              {t.cancel}
            </Button>
          </div>
        </div>
      ) : linked ? (
        <Button type="button" variant="secondary" disabled={busy || !moving} onClick={change}>
          {status.kind === "checking" && <LoaderCircleIcon aria-hidden="true" className="animate-spin" />}
          {t.change}
        </Button>
      ) : (
        <>
          <Button type="button" disabled={busy || !target} onClick={signIn}>
            {(status.kind === "browser" || status.kind === "checking") && (
              <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            )}
            {t.browser}
          </Button>
          <p className="text-sm text-muted-foreground">{registered && !moving ? t.signInHint : t.browserHint}</p>
          {registered && (
            <details className="rounded-lg border px-3 py-2.5">
              <summary className="cursor-pointer text-sm font-medium">{t.pat}</summary>
              <form onSubmit={submitPat} className="mt-2.5 flex flex-col gap-2">
                <Label htmlFor={`${id}-pat`}>{t.patLabel}</Label>
                <Input
                  id={`${id}-pat`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="hive_pat_…"
                  className="font-mono text-sm md:text-sm"
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">{t.patHint}</p>
                <Button type="submit" variant="secondary" className="self-start" disabled={busy || !pat.trim()}>
                  {t.patSubmit}
                </Button>
              </form>
            </details>
          )}
        </>
      )}
      {(!registered || confirming) && registerToken}
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "min-h-5 text-sm",
          status.kind === "error" && "text-destructive",
          (status.kind === "parsed" || status.kind === "signedIn" || status.kind === "moved") && "text-success",
          busy && "text-muted-foreground",
        )}
      >
        {message}
      </p>
    </div>
  );
}
