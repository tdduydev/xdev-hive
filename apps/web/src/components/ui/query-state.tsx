import { Button } from "@xdev-hive/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@xdev-hive/ui/empty";
import { Loader2Icon } from "lucide-react";
import { Alert } from "@/components/ui/alert.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";

export function LoadingState({ label = "Đang tải…" }: { label?: string }) {
  return (
    <p role="status" aria-busy="true" className="flex items-center gap-2 text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
      {label}
    </p>
  );
}

export function LoadFailure({ error, retry }: { error: unknown; retry: () => unknown }) {
  return (
    <Alert variant="destructive" className="grid justify-items-start gap-2">
      {apiErrorMessage(error)}
      <Button variant="outline" size="sm" onClick={() => retry()}>
        Tải lại
      </Button>
    </Alert>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="border border-dashed border-border">
      <EmptyHeader>
        <EmptyTitle role="heading" aria-level={2}>
          {title}
        </EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
