import { apiErrorMessage } from "../../lib/api-errors.ts";
import { Alert } from "./alert.tsx";
import { Button } from "./button.tsx";
import { Card } from "./card.tsx";

export function LoadingState({ label = "Đang tải…" }: { label?: string }) {
  return (
    <p role="status" aria-busy="true" className="text-muted">
      {label}
    </p>
  );
}

export function LoadFailure({ error, retry }: { error: unknown; retry: () => unknown }) {
  return (
    <Alert className="grid justify-items-start gap-2">
      {apiErrorMessage(error)}
      <Button size="sm" onClick={() => retry()}>
        Tải lại
      </Button>
    </Alert>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Card className="grid gap-2 px-4 py-8 text-center">
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="text-muted">{description}</p>
    </Card>
  );
}
