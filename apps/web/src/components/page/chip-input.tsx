import { XIcon } from "lucide-react";
import { useState } from "react";
import { type Dict, useT } from "@/lib/i18n.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{ removeChip: (value: string) => string }> = {
  vi: { removeChip: (value) => `Bỏ ${value}` },
  en: { removeChip: (value) => `Remove ${value}` },
};

/**
 * Ô nhiều giá trị gõ tự do (admin-layout.md § Form cài đặt): mỗi giá trị là một chip có nút bỏ, ô thêm ở cuối. Enter
 * thêm chip chứ không gửi form đang chứa nó; rời ô mà còn chữ thì cũng thêm, để không mất giá trị vừa gõ. Chọn từ một
 * danh sách có sẵn (người, dự án) thì dùng ô chọn, không dùng ô này.
 */
export function ChipInput({
  values,
  onChange,
  canWrite,
  addLabel,
  placeholder,
  boxed = false,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  canWrite: boolean;
  addLabel: string;
  placeholder: string;
  /** Có viền như một ô nhập (trong form); không viền khi nằm trong cột giai đoạn. */
  boxed?: boolean;
}) {
  const t = useT(text);
  const [draft, setDraft] = useState("");
  function add() {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  }
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1",
        boxed && "min-h-8 rounded-lg border border-input p-1.5 dark:bg-input/30",
      )}
    >
      {values.length === 0 && !canWrite && <span className="px-1 text-sm text-muted-foreground">—</span>}
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border bg-card px-2 font-mono text-xs break-all"
        >
          {v}
          {canWrite && (
            <button
              type="button"
              aria-label={t.removeChip(v)}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <XIcon className="size-3" aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      {canWrite && (
        <input
          aria-label={addLabel}
          placeholder={`+ ${placeholder}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
          onBlur={() => {
            if (draft.trim()) add();
          }}
          className={cn(
            "h-6 min-w-0 rounded-full bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
            boxed ? "flex-[1_1_10rem]" : "w-48 border border-dashed border-input focus-visible:border-ring",
          )}
        />
      )}
    </span>
  );
}
