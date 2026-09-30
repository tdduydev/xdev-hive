import * as React from "react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

// DS switch: md 36×20 (14px knob), sm 28×16 (10px knob); off = surface with a control border, on = primary.
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch inline-flex shrink-0 cursor-pointer items-center rounded-full border border-line-control bg-surface px-0.5 transition-colors duration-(--duration-fast) ease-standard outline-none focus-visible:focus-ring disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7 data-[state=checked]:border-primary data-[state=checked]:bg-primary",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-line-control shadow-e1 ring-0 transition-transform duration-(--duration-fast) ease-standard group-data-[size=default]/switch:size-3.5 group-data-[size=sm]/switch:size-2.5 group-disabled/switch:bg-disabled-fg data-[state=checked]:bg-primary-foreground group-data-[size=default]/switch:data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
