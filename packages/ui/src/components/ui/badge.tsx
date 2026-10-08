import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex h-[24px] w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-[999px] border-0 px-[10px] text-[11px]/4 font-semibold whitespace-nowrap transition-[color,box-shadow] outline-none focus-visible:focus-ring [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-(--glass-bg) text-fg-secondary shadow-[var(--ring-glass)]",
        secondary: "bg-neutral-soft text-neutral [a&]:hover:bg-hover",
        destructive: "bg-danger-soft text-danger [a&]:hover:bg-danger-soft",
        // Preserve the outline API; use Tag when a square chip is needed.
        outline: "rounded-xs border-line-default text-fg-secondary [a&]:hover:bg-hover [a&]:hover:text-fg-strong",
        ghost: "[a&]:hover:bg-hover [a&]:hover:text-fg-strong",
        link: "text-fg-link underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  tone = "neutral",
  dot = true,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean; tone?: "neutral" | "violet" | "blue" | "green" | "info" | "success" | "warning" | "danger"; dot?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {dot && !asChild && <span aria-hidden="true" className="cosmic-badge-dot" data-tone={tone} />}
      {children}
    </Comp>
  )
}

export { Badge, badgeVariants }
