import { cn } from "@/lib/utils.ts";

/** Công tắc bật/tắt (role="switch"); `danger` tô đỏ khi bật cho quyền rủi ro như cho phép toàn quyền. */
export function Toggle({
  on,
  label,
  onChange,
  disabled,
  danger,
}: {
  on: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        on ? (danger ? "bg-destructive" : "bg-primary") : "bg-input",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "block size-4 rounded-full bg-background shadow-sm transition-transform",
          on ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
