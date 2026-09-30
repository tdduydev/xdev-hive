import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-xd-shimmer rounded-xs bg-[linear-gradient(90deg,var(--bg-sunken)_25%,var(--border-subtle)_50%,var(--bg-sunken)_75%)] bg-size-[200%_100%] motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
