"use client"

import * as React from "react"
import { cn } from "cn"
import { CheckIcon, MinusIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group/checkbox size-[18px] shrink-0 cursor-pointer rounded-xs border border-line-control bg-surface transition-[background-color,border-color] duration-(--duration-instant) outline-none focus-visible:focus-ring disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled aria-invalid:border-2 aria-invalid:border-danger-solid data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon strokeWidth={2.5} className="size-3.5 group-data-[state=indeterminate]/checkbox:hidden" />
        <MinusIcon strokeWidth={2.5} className="hidden size-3.5 group-data-[state=indeterminate]/checkbox:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
