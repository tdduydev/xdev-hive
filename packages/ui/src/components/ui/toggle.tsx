"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Toggle as TogglePrimitive } from "radix-ui"

const toggleVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md type-label whitespace-nowrap text-fg-secondary transition-[background-color,color,box-shadow] duration-(--duration-instant) outline-none hover:bg-hover hover:text-fg-strong focus-visible:focus-ring disabled:pointer-events-none disabled:text-fg-disabled data-[state=on]:bg-selected data-[state=on]:text-selected-fg [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        // Inside a ToggleGroup this is the DS segmented control (sunken track, raised selected item).
        outline:
          "border border-action-secondary-line bg-action-secondary hover:bg-action-secondary-hover data-[state=on]:border-selected-line",
      },
      size: {
        default: "h-8 min-w-8 px-2",
        sm: "h-7 min-w-7 px-1.5",
        lg: "h-10 min-w-10 px-2.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
