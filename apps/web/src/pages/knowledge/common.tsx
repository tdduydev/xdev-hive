import type { KnowledgeAuthor, ScopeView } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert.tsx";
import { Card } from "@/components/ui/card.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useT } from "@/lib/i18n.ts";
import { knowledgeText } from "@/pages/knowledge/text.ts";

const text = knowledgeText;
export function KnowledgeLayout({
  title,
  lead,
  actions,
  children,
}: {
  title: string;
  lead: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const t = useT(text);
  return (
    <main className="min-w-0 space-y-4 p-4 md:px-8 md:py-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs text-muted-foreground">{t.knowledge}</p>
          <h1 className="font-heading text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-muted-foreground">{lead}</p>
        </div>
        {actions}
      </header>
      {children}
    </main>
  );
}
export function QueryState({ query }: { query: { isPending: boolean; error: unknown; refetch: () => unknown } }) {
  const t = useT(text);
  if (query.isPending)
    return (
      <p role="status" aria-busy="true" className="text-muted-foreground">
        {t.loading}
      </p>
    );
  if (query.error)
    return (
      <Alert variant="destructive">
        {apiErrorMessage(query.error)}
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>
          {t.retry}
        </Button>
      </Alert>
    );
  return null;
}
export function DetailCard({ children }: { children: ReactNode }) {
  return <Card className="min-w-0 gap-3 border border-border p-4">{children}</Card>;
}
export function ScopeBadge({ scope }: { scope: ScopeView }) {
  const t = useT(text);
  return (
    <span
      className={`inline-flex max-w-full self-start rounded-full px-2 py-0.5 text-xs ${scope.level === "team" ? "bg-success-soft text-success" : scope.level === "project" ? "bg-secondary text-secondary-foreground" : "bg-accent text-accent-foreground"}`}
    >
      {t[scope.level]}
    </span>
  );
}
export function authorLabel(author: KnowledgeAuthor) {
  return author.userId ?? (author.runId ? `run ${author.runId}` : "—");
}
export function DataPages({
  offset,
  count,
  onChange,
}: {
  offset: number;
  count: number;
  onChange: (offset: number) => void;
}) {
  const t = useT(text);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="outline" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - 50))}>
        {t.newer}
      </Button>
      <Button variant="outline" disabled={count < 50} onClick={() => onChange(offset + 50)}>
        {t.older}
      </Button>
    </div>
  );
}
