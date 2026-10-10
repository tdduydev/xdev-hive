// Kept for in-flight 72 branches; remove in 76h.
export { ErrorBoundary, CrashCard } from "@xdev-hive/ui-kit/components/ErrorBoundary.tsx";
import { ErrorBoundary, CrashCard } from "@xdev-hive/ui-kit/components/ErrorBoundary.tsx";
import { useHive } from "#ui/hooks.ts";
import type { ReactNode } from "react";

/** A page's boundary: cleared when another page opens; on the desktop the crash goes to the app's log. */
export function PageBoundary({ page, children }: { page: string; children: ReactNode }) {
  const { client } = useHive();
  return (
    <ErrorBoundary resetKey={page} onError={(text) => void client.desktop?.logError?.(text).catch(() => undefined)} fallback={(error, retry) => <CrashCard error={error} retry={retry} />}>
      {children}
    </ErrorBoundary>
  );
}
