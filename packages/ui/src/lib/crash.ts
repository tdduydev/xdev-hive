// What a crash the interface caught says, for the copy button and the desktop's log (see ErrorBoundary.tsx).

/** What a crash report says: the error, where it was thrown, and which page was open. */
export function crashText(error: unknown, componentStack?: string | null): string {
  const e = error instanceof Error ? error : new Error(String(error));
  return [
    `${e.name}: ${e.message}`,
    `page: ${typeof window === "undefined" ? "" : window.location.hash || "/"}`,
    e.stack ? `stack:\n${e.stack.split("\n").slice(0, 12).join("\n")}` : "",
    componentStack ? `components:${componentStack.split("\n").slice(0, 12).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
