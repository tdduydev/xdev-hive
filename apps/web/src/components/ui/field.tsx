import { Field as BaseField } from "@base-ui/react/field";
import { cx } from "../../lib/cx.ts";

type WithClass<P> = Omit<P, "className"> & { className?: string };

/** Nhóm nhãn + ô nhập + gợi ý + lỗi. Base UI tự nối `for`, `aria-describedby`, `aria-invalid`. */
export function Field({ className, ...props }: WithClass<BaseField.Root.Props>) {
  return <BaseField.Root className={cx("grid gap-1.5", className)} {...props} />;
}

export function FieldLabel({ className, ...props }: WithClass<BaseField.Label.Props>) {
  return <BaseField.Label className={cx("text-sm font-medium text-foreground", className)} {...props} />;
}

export function FieldHint({ className, ...props }: WithClass<BaseField.Description.Props>) {
  return <BaseField.Description className={cx("text-xs text-muted-foreground", className)} {...props} />;
}

/** Luôn hiện khi được render; điều kiện hiện do nơi gọi quyết (đặt kèm `invalid` trên `<Field>`). */
export function FieldError({ className, ...props }: WithClass<Omit<BaseField.Error.Props, "match">>) {
  return <BaseField.Error match className={cx("text-xs text-destructive", className)} {...props} />;
}
