import { Button } from "@xdev-hive/ui/button";
import { FolderOpenIcon } from "lucide-react";
import { pickFolder, useFolder } from "@/lib/folder.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{ pick: string; title: string }> = {
  vi: { pick: "Chọn thư mục", title: "Chọn thư mục làm việc" },
  en: { pick: "Choose folder", title: "Choose a working folder" },
};

/**
 * Nút nhỏ cạnh phần nào cần thư mục làm việc: mở bộ chọn thư mục của hệ điều hành, chọn xong thì mọi màn đổi theo
 * (useFolder). Phần không cần thư mục vẫn hiện, nên nút chỉ là lời mời, không chặn màn.
 */
export function PickFolderButton({ className }: { className?: string }) {
  const t = useT(text);
  const [, setFolder] = useFolder();
  return (
    <Button
      variant="outline"
      size="xs"
      className={cn("self-start", className)}
      onClick={async () => {
        try {
          const picked = await pickFolder(t.title);
          if (picked) setFolder(picked);
        } catch {
          /* Ngoài Tauri không có bộ chọn thư mục; màn Môi trường và Token vẫn cho nhập tay. */
        }
      }}
    >
      <FolderOpenIcon aria-hidden="true" />
      {t.pick}
    </Button>
  );
}
