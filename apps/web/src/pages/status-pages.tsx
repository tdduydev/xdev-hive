import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Brand } from "../components/icons.tsx";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";

function Centered({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-6">
      <Card className="grid w-full max-w-105 gap-4 p-7">
        <Brand />
        <h1 className="font-heading text-xl font-semibold text-foreground">{title}</h1>
        {children}
      </Card>
    </main>
  );
}

/** Không hỏi được hub người đang đăng nhập là ai (mất mạng, hub tắt hoặc lỗi). */
export function LoadErrorPage(_: ErrorComponentProps) {
  const router = useRouter();
  return (
    <Centered title="Không kết nối được hub">
      <p className="text-muted-foreground">
        Hub không trả lời hoặc đang gặp lỗi. Kiểm tra mạng, đợi một lát rồi thử lại.
      </p>
      <Button variant="default" onClick={() => router.invalidate()}>
        Thử lại
      </Button>
    </Centered>
  );
}

export function NotFoundPage() {
  return (
    <Centered title="Không tìm thấy trang">
      <p className="text-muted-foreground">Đường dẫn này không có trên hub, hoặc màn hình chưa được làm.</p>
      <Link to="/" className={buttonVariants({ variant: "default" })}>
        Về trang chủ
      </Link>
    </Centered>
  );
}

export function PendingPage() {
  return (
    <main className="grid min-h-dvh place-items-center text-muted-foreground" aria-busy="true">
      Đang tải…
    </main>
  );
}
