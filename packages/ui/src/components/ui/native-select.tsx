import * as React from "react"
import { cn } from "cn"
import { ChevronsUpDownIcon } from "lucide-react"

function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & { size?: "sm" | "default" }) {
  return (
    <div
      className="group/native-select relative w-fit"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "h-8 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-line-control bg-surface px-2.5 py-0 pr-8 type-body-md text-fg-primary transition-[border-color,box-shadow] duration-(--duration-fast) outline-none placeholder:text-fg-muted hover:border-fg-muted disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-disabled-line disabled:bg-disabled disabled:text-disabled-fg data-[size=sm]:h-7 data-[size=sm]:rounded-sm data-[size=sm]:type-body-sm",
          "focus:border-ring focus:ring-3 focus:ring-selected",
          "aria-invalid:border-2 aria-invalid:border-danger-solid",
          className
        )}
        {...props}
      />
      <ChevronsUpDownIcon
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-fg-muted select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  )
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<"option">) {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<"optgroup">) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  )
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }
