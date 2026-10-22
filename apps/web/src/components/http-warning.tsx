import { Alert } from "@xdev-hive/ui/alert";
import { TriangleAlertIcon } from "lucide-react";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<Record<"warning", string>> = {
  vi: {
    warning: "Hub chạy HTTP: nội dung phiên và phím gõ đi qua mạng không mã hoá, chỉ dùng trong mạng nội bộ.",
  },
  en: {
    warning:
      "The hub runs on HTTP: session output and keystrokes cross the network unencrypted. Use it only on an internal network.",
  },
};

/**
 * Cảnh báo hub chạy HTTP (specs/010 Q2, T028) trên danh sách và màn terminal. localhost cũng là secure context, nên cảnh
 * báo chỉ hiện khi trang thật sự không được mã hoá.
 */
export function HttpWarning({ secure = window.isSecureContext }: { secure?: boolean }) {
  const t = useT(text);
  if (secure) return null;
  return (
    <Alert className="grid-cols-[auto_1fr]">
      <TriangleAlertIcon aria-hidden="true" />
      <div className="text-sm">{t.warning}</div>
    </Alert>
  );
}
