import { Input } from "@xdev-hive/ui/input";
import { useId } from "react";
import { Field, FieldError, FieldHint, FieldLabel } from "@/components/ui/field.tsx";

/**
 * Ô số của form cài đặt có đơn vị nằm trong ô (admin-layout.md § Form cài đặt: `USD`, `%`, `token`): đơn vị đứng sau số
 * nên người đọc không phải tìm nó ở nhãn. Chữ mono để các ô xếp cạnh nhau thẳng hàng chữ số. Lỗi thay chỗ gợi ý.
 */
export function UnitField({
  label,
  hint,
  error,
  value,
  onChange,
  disabled = false,
  inputMode,
  placeholder,
  suffix,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputMode?: "decimal" | "numeric";
  placeholder?: string | undefined;
  suffix?: string | undefined;
}) {
  const id = useId();
  return (
    <Field invalid={error !== undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="relative flex items-center">
        <Input
          id={id}
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          inputMode={inputMode}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-sm"
          // Chừa đủ chỗ cho đơn vị dài ("USD/lượt") để số không chạy xuống dưới nó.
          style={suffix ? { paddingRight: `calc(${suffix.length}ch + 1.25rem)` } : undefined}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 font-mono text-xs text-muted-foreground">{suffix}</span>
        )}
      </div>
      {error ? <FieldError>{error}</FieldError> : hint && <FieldHint>{hint}</FieldHint>}
    </Field>
  );
}
