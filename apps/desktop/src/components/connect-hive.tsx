import { Button } from "@xdev-hive/ui/button";
import { CloudOffIcon } from "lucide-react";
import { useConnect } from "@/lib/account.ts";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ title: string; lead: string; local: string; connect: string }> = {
  vi: {
    title: "Kết nối Hive để dùng mục này",
    lead: "Mục này lấy dữ liệu của đội bạn trên hub Hive.",
    local: "Các mục trong nhóm Máy này vẫn dùng được khi chưa kết nối.",
    connect: "Kết nối Hive",
  },
  en: {
    title: "Connect to Hive to use this",
    lead: "This section reads your team's data on the Hive hub.",
    local: "Everything under This machine works without connecting.",
    connect: "Connect to Hive",
  },
};

/** Chỉ nút mở hộp thoại Tài khoản, cho chỗ chật (đầu màn, cột bên) đã có câu nhắc riêng. */
export function ConnectHiveButton({ className }: { className?: string }) {
  const t = useT(text);
  const connect = useConnect();
  if (!connect) return null;
  return (
    <Button size="sm" variant="outline" className={className} onClick={connect}>
      {t.connect}
    </Button>
  );
}

/**
 * Chỗ của màn cần hub khi chưa đăng nhập: lời mời kết nối thay vì lỗi gọi hub hay màn trắng. `inline` là một dòng trong
 * màn có cả phần tại máy (Dự án, Tổng quan…), để phần tại máy vẫn hiện đủ.
 */
export function ConnectHive({ inline = false, note }: { inline?: boolean; note?: string }) {
  const t = useT(text);
  const connect = useConnect();
  if (inline)
    return (
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <p className="min-w-60 flex-1 text-sm text-muted-foreground">{note ?? t.title}</p>
        {connect && (
          <Button size="sm" variant="outline" onClick={connect}>
            {t.connect}
          </Button>
        )}
      </div>
    );
  return (
    <section
      aria-labelledby="connect-hive"
      className="mx-auto my-auto flex max-w-md flex-col items-center gap-3 px-5 py-12 text-center"
    >
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <CloudOffIcon aria-hidden="true" className="size-5" />
      </span>
      <h2 id="connect-hive" className="font-heading text-base font-semibold">
        {t.title}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t.lead} {t.local}
      </p>
      {connect && <Button onClick={connect}>{t.connect}</Button>}
    </section>
  );
}
