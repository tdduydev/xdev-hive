import { TOTP } from "@xdev-hive/contracts/terminal-auth";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { type FormEvent, useId, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { isTotpCode, lockMinutesLeft, totpWaitSec } from "@/lib/terminal/totp-auth.ts";
import { useNow } from "@/lib/use-now.ts";

const text: Dict<
  Record<"label" | "hint" | "title" | "description" | "submit" | "sending" | "cancel", string> & {
    wait: (sec: number) => string;
    locked: (min: number) => string;
  }
> = {
  vi: {
    label: "Mã Authenticator",
    hint: "6 chữ số trong app Authenticator đã ghép với máy này.",
    title: "Nhập mã Authenticator",
    description: "Hub chạy HTTP nên trình duyệt không dùng được passkey. Mỗi mã chỉ dùng được một lần.",
    submit: "Xác nhận",
    sending: "Đang xác thực…",
    cancel: "Thôi",
    wait: (sec) => `Mã vừa được dùng. Chờ mã mới (${sec} giây).`,
    locked: (min) => `Còn khoảng ${min} phút nữa mới nhập lại được.`,
  },
  en: {
    label: "Authenticator code",
    hint: "The 6 digits in the Authenticator app paired with this machine.",
    title: "Enter Authenticator code",
    description: "The hub runs on HTTP, so the browser cannot use passkeys. Each code works only once.",
    submit: "Confirm",
    sending: "Verifying…",
    cancel: "Never mind",
    wait: (sec) => `That code was just used. Wait for a new one (${sec} s).`,
    locked: (min) => `You can try again in about ${min} min.`,
  },
};

export interface TotpError {
  code: string;
  message: string;
}

/**
 * Ô 6 số và trạng thái của nó (mã vừa dùng, sai, khoá còn bao lâu). Dùng chung cho tấm "Mở phiên mới" và hộp xin quyền
 * gõ. `lockedUntil` lấy từ trạng thái máy báo hub (`term_state`), máy mới là nơi tính khoá.
 */
export function TotpCodeField({
  value,
  onChange,
  error,
  lockedUntil,
}: {
  value: string;
  onChange: (code: string) => void;
  error: TotpError | null;
  lockedUntil?: string | null | undefined;
}) {
  const t = useT(text);
  const id = useId();
  const hintId = useId();
  const now = useNow(1000);
  const wait = totpWaitSec(now);
  const lockMin = error?.code === "TOTP_LOCKED" ? lockMinutesLeft(lockedUntil, now) : null;
  return (
    <div className="grid min-w-0 gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {t.label}
      </label>
      <Input
        id={id}
        value={value}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={TOTP.digits}
        aria-describedby={hintId}
        aria-invalid={error ? true : undefined}
        className="h-11 max-w-[12rem] font-mono text-lg tracking-[0.3em]"
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, TOTP.digits))}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        {t.hint}
      </p>
      {wait > 0 && (
        <p role="status" className="text-xs font-medium text-foreground">
          {t.wait(wait)}
        </p>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          {error.message}
          {lockMin !== null && ` ${t.locked(lockMin)}`}
        </Alert>
      )}
    </div>
  );
}

/** Mã đủ 6 số và không phải mã của bước vừa dùng (máy sẽ từ chối `TOTP_REPLAY`). */
export const totpReady = (code: string, now: number = Date.now()) => isTotpCode(code) && totpWaitSec(now) === 0;

/** Hộp nhập mã khi xin quyền gõ trên trang phiên (hub HTTP). */
export function TotpCodeSheet({
  open,
  onOpenChange,
  onSubmit,
  pending,
  error,
  lockedUntil,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (code: string) => void;
  pending: boolean;
  error: TotpError | null;
  lockedUntil?: string | null | undefined;
}) {
  const t = useT(text);
  const [code, setCode] = useState("");
  const now = useNow(1000, open);
  const ready = totpReady(code, now) && !pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    onSubmit(code);
    setCode("");
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto w-full max-w-md rounded-t-xl sm:border-x">
        <form noValidate onSubmit={submit} className="grid min-w-0 gap-3.5 px-4 pb-4">
          <SheetHeader className="px-0 pr-10">
            <SheetTitle>{t.title}</SheetTitle>
            <SheetDescription>{t.description}</SheetDescription>
          </SheetHeader>
          <TotpCodeField value={code} onChange={setCode} error={error} lockedUntil={lockedUntil} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="h-11" onClick={() => onOpenChange(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" className="h-11" disabled={!ready}>
              {pending ? t.sending : t.submit}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
