import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { type Dict, type Lang, setLang, useLang, useT } from "@/lib/i18n.ts";
import { cn } from "@/lib/utils.ts";

const text: Dict<{ label: string }> = { vi: { label: "Ngôn ngữ" }, en: { label: "Language" } };

/** Tên ngôn ngữ viết bằng chính ngôn ngữ đó, để người không đọc được ngôn ngữ đang chọn vẫn tìm ra. */
const LANG_NAME: Record<Lang, string> = { vi: "Tiếng Việt", en: "English" };

/** Chọn ngôn ngữ giao diện bằng danh sách thả xuống. */
export function LangToggle({ className }: { className?: string }) {
  const lang = useLang();
  const t = useT(text);
  return (
    <NativeSelect
      size="sm"
      aria-label={t.label}
      className={cn("w-32", className)}
      value={lang}
      onChange={(e) => setLang(e.target.value as Lang)}
    >
      {(["vi", "en"] as const satisfies readonly Lang[]).map((value) => (
        <NativeSelectOption key={value} value={value}>
          {LANG_NAME[value]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
