import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { Button, buttonVariants } from "@xdev-hive/ui/button";
import type { ReactNode } from "react";
import { Brand } from "@/components/icons.tsx";
import { OutsideLayout } from "@/components/outside/outside-layout.tsx";
import { isHubUnreachable } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{
  loading: string;
  retry: string;
  home: string;
  errorTitle: string;
  errorBody: string;
  crashTitle: string;
  crashBody: string;
  missingTitle: string;
  missingBody: string;
}> = {
  vi: {
    loading: "Đang tải…",
    retry: "Thử lại",
    home: "Về trang chủ",
    errorTitle: "Không kết nối được hub",
    errorBody: "Hub không trả lời hoặc đang gặp lỗi. Kiểm tra mạng, đợi một lát rồi thử lại.",
    crashTitle: "Màn hình gặp lỗi",
    crashBody: "Màn hình này gặp lỗi không mong muốn. Thử lại; nếu vẫn lỗi, tải lại trang hoặc báo quản trị hub.",
    missingTitle: "Không tìm thấy trang",
    missingBody: "Đường dẫn này không có trên hub, hoặc màn hình chưa được làm.",
  },
  en: {
    loading: "Loading…",
    retry: "Try again",
    home: "Go home",
    errorTitle: "Cannot reach the hub",
    errorBody: "The hub is not responding or has an error. Check your network, wait a moment, then try again.",
    crashTitle: "This screen hit an error",
    crashBody:
      "Something unexpected went wrong on this screen. Try again; if it persists, reload the page or tell your hub admin.",
    missingTitle: "Page not found",
    missingBody: "This address does not exist on the hub, or the screen is not built yet.",
  },
};

function Centered({
  code,
  title,
  body,
  children,
}: {
  code?: string | undefined;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <OutsideLayout centered>
      <div className="flex w-full max-w-110 flex-col items-center gap-4 text-center">
        {code && <span className="font-mono text-7xl font-semibold tracking-tighter text-border">{code}</span>}
        <Brand className="h-12" />
        <h1 className="font-heading text-[22px] font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground">{body}</p>
        {children}
      </div>
    </OutsideLayout>
  );
}

export function LoadErrorPage({ error }: ErrorComponentProps) {
  const router = useRouter();
  const t = useT(text);
  // Mọi lỗi chưa có chỗ bắt riêng (cả lỗi vẽ trang) đều về đây; báo "không kết nối được hub" cho lỗi của trang thì người
  // dùng đi kiểm tra mạng trong khi hub vẫn chạy.
  const hub = isHubUnreachable(error);
  return (
    <Centered
      code={hub ? "503" : undefined}
      title={hub ? t.errorTitle : t.crashTitle}
      body={hub ? t.errorBody : t.crashBody}
    >
      <Button onClick={() => router.invalidate()}>
        <Spinner />
        {t.retry}
      </Button>
    </Centered>
  );
}

export function NotFoundPage() {
  const t = useT(text);
  return (
    <Centered code="404" title={t.missingTitle} body={t.missingBody}>
      <Link to="/" className={buttonVariants({ variant: "default" })}>
        {t.home}
      </Link>
    </Centered>
  );
}

function Spinner({ spinning = false }: { spinning?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className={spinning ? "size-7 text-primary motion-safe:animate-spin" : "size-4"}
    >
      <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    </svg>
  );
}

export function PendingPage() {
  const t = useT(text);
  return (
    <OutsideLayout centered>
      <div role="status" aria-busy="true" className="flex flex-col items-center gap-3.5 text-muted-foreground">
        <Spinner spinning />
        {t.loading}
      </div>
    </OutsideLayout>
  );
}
