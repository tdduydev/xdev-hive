// React unmounts the whole tree on an error thrown while rendering, so one page that broke left the app a blank
// window, with nothing to report (asked 2/10: "app client hay bị trắng"). A boundary keeps the rest of the app and
// says what broke; the desktop also writes it to its log.
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { crashText } from "#ui/lib/crash.ts";

interface Props {
  /** A new value (the page that is open) clears the error: going to another page works again. */
  resetKey?: unknown;
  onError?: (text: string) => void;
  fallback: (error: Error, retry: () => void) => ReactNode;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const text = crashText(error, info.componentStack);
    console.error(text);
    this.props.onError?.(text);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  retry = (): void => this.setState({ error: null });

  override render(): ReactNode {
    return this.state.error ? this.props.fallback(this.state.error, this.retry) : this.props.children;
  }
}

/** The card shown in place of a page (or of the whole app) that broke. */
export function CrashCard({ error, retry, whole = false }: { error: Error; retry: () => void; whole?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div role="alert" className={whole ? "flex min-h-svh items-center justify-center p-6" : "flex justify-center p-6"}>
      <div className="flex w-full max-w-xl flex-col gap-3 rounded-lg border border-danger-line bg-danger-soft p-5 text-sm">
        <h2 className="text-base font-semibold">{t(whole ? "crash.titleApp" : "crash.title")}</h2>
        <p className="text-muted-foreground">{t(whole ? "crash.hintApp" : "crash.hint")}</p>
        <pre className="max-h-40 overflow-auto rounded-md bg-background/70 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{`${error.name}: ${error.message}`}</pre>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={retry}>
            {t("crash.retry")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            {t("crash.reload")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigator.clipboard?.writeText(crashText(error)).then(
                () => setCopied(true),
                () => undefined,
              )
            }
          >
            {copied ? t("crash.copied") : t("crash.copy")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A page's boundary: cleared when another page opens; on the desktop the crash goes to the app's log. */
export function PageBoundary({ page, children }: { page: string; children: ReactNode }) {
  const { client } = useHive();
  return (
    <ErrorBoundary resetKey={page} onError={(text) => void client.desktop?.logError?.(text).catch(() => undefined)} fallback={(error, retry) => <CrashCard error={error} retry={retry} />}>
      {children}
    </ErrorBoundary>
  );
}
