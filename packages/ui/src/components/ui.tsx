import type { ReactNode } from "react";

export function Badge({ tone = "neutral", children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div className="note note-error" role="alert">
      {error}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function HiveLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
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
