import * as React from "react"
import { cn } from "cn"

// controlSize preserves the native numeric size attribute used by existing form callers.
function Input({ className, type, controlSize = "md", icon, trailing, ...props }: React.ComponentProps<"input"> & { controlSize?: "sm" | "md" | "lg"; icon?: React.ReactNode; trailing?: React.ReactNode }) {
  const input = (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full min-w-0 rounded-[12px] border-0 bg-sunken px-[14px] py-0 text-[14px]/[22px] font-medium shadow-[var(--ring-glass)] text-fg-primary transition-[border-color,box-shadow] duration-(--duration-fast) outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-fg-strong placeholder:text-fg-muted hover:border-fg-muted",
        "focus:border-ring focus:ring-3 focus:ring-selected",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled disabled:text-disabled-fg",
        "aria-invalid:border-2 aria-invalid:border-danger-solid",
        icon || trailing ? "h-full bg-transparent px-0 shadow-none focus:ring-0" : { sm: "h-[36px]", md: "h-[44px]", lg: "h-[52px]" }[controlSize],
        className
      )}
      {...props}
    />
  )
  return icon || trailing ? <div className="cosmic-input-group" style={{ height: { sm: 36, md: 44, lg: 52 }[controlSize] }}>{icon}{input}{trailing}</div> : input
}

export { Input }
