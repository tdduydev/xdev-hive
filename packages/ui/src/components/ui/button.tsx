import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Legacy variant names remain valid for callers while cosmic variants share semantic tokens.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px]/5 font-semibold whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-(--duration-instant) ease-standard outline-none focus-visible:focus-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled disabled:text-disabled-fg aria-invalid:border-danger-solid [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        glass: "cosmic-button-glass",
        solid: "cosmic-button-solid",
        blue: "cosmic-button-blue",
        default: "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
        destructive: "bg-action-danger text-action-danger-fg hover:bg-action-danger-hover active:bg-action-danger-hover",
        outline:
          "border border-action-secondary-line bg-action-secondary text-action-secondary-fg hover:bg-action-secondary-hover active:bg-action-secondary-active",
        secondary:
          "border border-action-secondary-line bg-action-secondary text-action-secondary-fg hover:bg-action-secondary-hover active:bg-action-secondary-active",
        ghost: "text-fg-primary hover:bg-ghost-hover hover:text-fg-strong active:bg-ghost-active",
        "danger-outline": "border border-danger-line bg-transparent text-danger hover:bg-danger-soft active:bg-danger-soft",
        // At most one per screen: the gradient border is reserved for the main brand action.
        brand:
          "border-[1.5px] border-transparent text-fg-brand [background:linear-gradient(var(--bg-surface),var(--bg-surface))_padding-box,var(--brand-gradient)_border-box] hover:shadow-[0_0_0_3px_var(--state-selected-bg)]",
        link: "h-auto px-1 font-medium text-fg-link underline underline-offset-3 hover:text-fg-link-hover",
      },
      size: {
        md: "h-[var(--button-h-md)] px-5",
        default: "h-8 px-3",
        xs: "h-6 gap-1 rounded-sm px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 rounded-sm px-2.5 text-xs/none",
        lg: "h-10 px-4 text-sm/none",
        icon: "size-8",
        "icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-sm",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "glass",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "glass",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
