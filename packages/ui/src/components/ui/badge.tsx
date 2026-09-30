import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex h-[22px] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 type-caption whitespace-nowrap transition-[color,box-shadow] outline-none focus-visible:focus-ring [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary-hover",
        secondary: "bg-neutral-soft text-neutral [a&]:hover:bg-hover",
        destructive: "bg-danger-soft text-danger [a&]:hover:bg-danger-soft",
        // Outline chips (project keys, model tags) are square-ish per the DS.
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
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
