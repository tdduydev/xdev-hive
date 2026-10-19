import { cn } from "@/lib/utils.ts";

/** Vòng mục bắt buộc đã đủ trên tổng số mục bắt buộc của Môi trường; đủ hết thì vòng màu thành công. */
export function ScoreRing({
  ready,
  required,
  label,
  small = false,
}: {
  ready: number;
  required: number;
  label: string;
  small?: boolean;
}) {
  const pct = required ? Math.round((ready / required) * 100) : 100;
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full", small ? "size-14" : "size-18")}
      style={{
        background: `conic-gradient(var(${pct === 100 ? "--success" : "--primary"}) ${pct}%, var(--muted) 0)`,
      }}
    >
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-background font-mono font-semibold",
          small ? "size-10.5 text-sm" : "size-14 text-[15px]",
        )}
      >
        {ready}/{required}
      </span>
    </div>
  );
}
