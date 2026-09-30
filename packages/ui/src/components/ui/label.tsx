import * as React from "react"
import { cn } from "cn"
import { Label as LabelPrimitive } from "radix-ui"

function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 type-label text-fg-strong select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:text-fg-disabled peer-disabled:cursor-not-allowed peer-disabled:text-fg-disabled",
        className
      )}
      {...props}
    />
  )
}

export { Label }
