import * as React from "react"
import { cn } from "cn"

// DS input: 32 tall, 1px control border, focus = blue border + 3px selected halo; errors get a 2px danger border.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-line-control bg-surface px-2.5 py-0 type-body-md text-fg-primary transition-[border-color,box-shadow] duration-(--duration-fast) outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-fg-strong placeholder:text-fg-muted hover:border-fg-muted",
        "focus:border-ring focus:ring-3 focus:ring-selected",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled disabled:text-disabled-fg",
        "aria-invalid:border-2 aria-invalid:border-danger-solid",
        className
      )}
      {...props}
    />
  )
}

export { Input }
