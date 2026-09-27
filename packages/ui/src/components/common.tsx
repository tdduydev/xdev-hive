// Small building blocks every page uses, on top of shadcn/ui.
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/components/ui/alert";
import { Badge as UiBadge } from "@xdev-hive/ui/components/ui/badge";

/** Status colours: tinted backgrounds with the matching text, readable in light and dark. */
const TONE: Record<string, string> = {
  ok: "border-transparent bg-success/12 text-success",
  warn: "border-transparent bg-warning/15 text-warning",
  info: "border-transparent bg-info/12 text-info",
  danger: "border-transparent bg-destructive/12 text-destructive",
  accent: "border-transparent bg-brand-soft text-brand-soft-foreground",
  neutral: "border-transparent bg-muted text-muted-foreground",
};

export function Badge({ tone = "neutral", className, children }: { tone?: string; className?: string; children: ReactNode }) {
  return <UiBadge className={cn(TONE[tone] ?? TONE.neutral, "font-medium", className)}>{children}</UiBadge>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
    </Alert>
  );
}

const NOTICE = {
  ok: { icon: CircleCheck, className: "border-success/30 bg-success/8 text-success" },
  warn: { icon: TriangleAlert, className: "border-warning/35 bg-warning/10 text-warning" },
  info: { icon: Info, className: "border-info/30 bg-info/8 text-info" },
  error: { icon: CircleAlert, className: "border-destructive/30 bg-destructive/8 text-destructive" },
} as const;

/** A tinted message box (saved, warning, hint). Errors from actions use ErrorNote. */
export function Notice({ tone = "info", title, className, children }: { tone?: keyof typeof NOTICE; title?: ReactNode; className?: string; children?: ReactNode }) {
  const { icon: Icon, className: toneClass } = NOTICE[tone];
  return (
    <Alert className={cn(toneClass, className)}>
      <Icon />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children ? <AlertDescription className="text-foreground/80">{children}</AlertDescription> : null}
    </Alert>
  );
}

const DOT: Record<string, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  info: "bg-info",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/40",
};

/** Small status light (online, running, resting…). */
export function StatusDot({ tone = "neutral", className }: { tone?: string; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", DOT[tone] ?? DOT.neutral, className)} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="max-w-3xl text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Page body for converted pages (the legacy ones use the .page class). */
export function Page({ wide, className, children }: { wide?: boolean; className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto flex w-full flex-col gap-6 p-4 md:p-6", wide ? "max-w-7xl" : "max-w-6xl", className)}>{children}</div>;
}

export function HiveLogo({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={cn("text-brand", className)}>
      <path d="M12 2.5 20.2 7.25v9.5L12 21.5l-8.2-4.75v-9.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8.2 15.3 10.1v3.8L12 15.8l-3.3-1.9v-3.8Z" fill="currentColor" />
    </svg>
  );
}

export const STATUS_TONE: Record<string, string> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
  conflict: "danger",
  todo: "neutral",
  doing: "info",
  review: "warn",
  done: "ok",
  blocked: "danger",
  queued: "neutral",
  running: "info",
  succeeded: "ok",
  failed: "danger",
  rate_limited: "warn",
  cancelled: "neutral",
  admin: "accent",
  agent: "info",
  viewer: "neutral",
};
