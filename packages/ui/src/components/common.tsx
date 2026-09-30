// Small building blocks every page uses, on top of shadcn/ui.
import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/components/ui/alert";
import { Badge as UiBadge } from "@xdev-hive/ui/components/ui/badge";
import { useT } from "../i18n/index.tsx";

/** Status colours: tinted backgrounds with the matching text, readable in light and dark. */
const TONE: Record<string, string> = {
  ok: "border-transparent bg-success-soft text-success",
  warn: "border-transparent bg-warning-soft text-warning",
  info: "border-transparent bg-info-soft text-info",
  running: "border-transparent bg-running-soft text-running",
  danger: "border-transparent bg-danger-soft text-danger",
  accent: "border-transparent bg-selected text-selected-fg",
  neutral: "border-transparent bg-neutral-soft text-neutral",
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

/** Who an item belongs to: "Chung" (every project, owner null) or the project key. */
export function OwnerBadge({ owner, className }: { owner: string | null; className?: string }) {
  const t = useT();
  return owner === null ? (
    <Badge tone="accent" className={className}>
      {t("common.shared")}
    </Badge>
  ) : (
    <UiBadge variant="outline" className={cn("font-mono font-normal text-muted-foreground", className)}>
      {owner}
    </UiBadge>
  );
}

const NOTICE = {
  ok: { icon: CircleCheck, className: "border-success-line bg-success-soft [&>svg]:text-success" },
  warn: { icon: TriangleAlert, className: "border-warning-line bg-warning-soft [&>svg]:text-warning" },
  info: { icon: Info, className: "border-info-line bg-info-soft [&>svg]:text-info" },
  error: { icon: CircleAlert, className: "border-danger-line bg-danger-soft [&>svg]:text-danger" },
} as const;

/** A tinted message box (saved, warning, hint). Errors from actions use ErrorNote. */
export function Notice({ tone = "info", title, className, children }: { tone?: keyof typeof NOTICE; title?: ReactNode; className?: string; children?: ReactNode }) {
  const { icon: Icon, className: toneClass } = NOTICE[tone];
  return (
    <Alert className={cn(toneClass, className)}>
      <Icon />
      {title ? <AlertTitle className="text-fg-strong">{title}</AlertTitle> : null}
      {children ? <AlertDescription className="text-fg-strong">{children}</AlertDescription> : null}
    </Alert>
  );
}

const DOT: Record<string, string> = {
  ok: "bg-success-solid",
  warn: "bg-warning-solid",
  info: "bg-info-solid",
  running: "bg-info-solid",
  danger: "bg-danger-solid",
  neutral: "bg-neutral-solid",
};

/** Small status light (online, running, resting…). */
export function StatusDot({ tone = "neutral", className }: { tone?: string; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", DOT[tone] ?? DOT.neutral, className)} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line-default bg-surface px-5 py-8 text-center type-body-sm text-fg-secondary">{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="type-display-md text-fg-strong">{title}</h1>
        {subtitle ? <p className="max-w-3xl type-body-sm text-fg-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Page body for converted pages (the legacy ones use the .page class). */
export function Page({ wide, className, children }: { wide?: boolean; className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto flex w-full flex-col gap-6 p-4 md:p-6", wide ? "max-w-7xl" : "max-w-6xl", className)}>{children}</div>;
}

export const STATUS_TONE: Record<string, string> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
  conflict: "danger",
  todo: "neutral",
  doing: "running",
  review: "warn",
  done: "ok",
  blocked: "danger",
  queued: "neutral",
  running: "running",
  succeeded: "ok",
  failed: "danger",
  rate_limited: "warn",
  cancelled: "neutral",
  admin: "accent",
  member: "ok",
  agent: "info",
  viewer: "neutral",
};
