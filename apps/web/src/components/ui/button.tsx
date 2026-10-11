import { Button as BaseButton } from "@base-ui/react/button";
import { cx } from "../../lib/cx.ts";

const variants = {
  default: "border-line-strong bg-surface text-ink hover:not-data-disabled:bg-subtle",
  primary: "border-accent bg-accent text-on-accent hover:not-data-disabled:bg-accent-hover",
  danger: "border-bad bg-surface text-bad hover:not-data-disabled:bg-bad-bg",
  // Mockup không đổi nền khi rê chuột lên nút ghost; thêm nền nhạt để biết là bấm được.
  ghost: "border-transparent bg-transparent text-ink hover:not-data-disabled:bg-subtle",
};

const sizes = {
  md: "h-9 px-3.5",
  sm: "h-7 px-2.5 text-sm",
  /** Nút chỉ có biểu tượng; cần `aria-label`. */
  icon: "size-7",
};

export interface ButtonStyle {
  variant?: keyof typeof variants | undefined;
  size?: keyof typeof sizes | undefined;
  /** Rộng hết khung chứa. */
  block?: boolean | undefined;
}

/** Class của nút, dùng thẳng cho `<Link>`: Base UI không cho render thẻ `<a>` qua `<Button>` vì sai ngữ nghĩa. */
export function buttonClass({ variant = "default", size = "md", block = false }: ButtonStyle = {}): string {
  return cx(
    "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium select-none",
    "data-disabled:cursor-not-allowed data-disabled:opacity-60",
    variants[variant],
    sizes[size],
    block && "w-full",
  );
}

export interface ButtonProps extends ButtonStyle, Omit<BaseButton.Props, "className"> {
  className?: string;
}

export function Button({ variant, size, block, className, ...props }: ButtonProps) {
  return <BaseButton className={cx(buttonClass({ variant, size, block }), className)} {...props} />;
}
