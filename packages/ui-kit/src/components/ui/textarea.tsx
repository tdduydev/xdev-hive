import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-[88px] w-full resize-y rounded-md border border-line-control bg-surface px-2.5 py-2 type-body-md text-fg-primary transition-[border-color,box-shadow] duration-(--duration-fast) outline-none placeholder:text-fg-muted hover:border-fg-muted focus:border-ring focus:ring-3 focus:ring-selected disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled disabled:text-disabled-fg aria-invalid:border-2 aria-invalid:border-danger-solid",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
