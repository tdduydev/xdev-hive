import { Input as BaseInput } from "@base-ui/react/input";
import { cx } from "../../lib/cx.ts";

export interface InputProps extends Omit<BaseInput.Props, "className"> {
  className?: string;
}

/** Ô nhập một dòng. Đặt trong `<Field>` để tự gắn nhãn, gợi ý và lỗi. */
export function Input({ className, ...props }: InputProps) {
  return (
    <BaseInput
      className={cx(
        "h-9.5 w-full rounded-md border border-input bg-card px-2.75 placeholder:text-muted-foreground",
        "data-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
