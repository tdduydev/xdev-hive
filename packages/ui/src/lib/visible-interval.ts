// Only the desktop app's own window: its hidden/minimized state is real there. In a browser (and the web e2e's
// show:false windows) document.hidden says nothing about whether anyone waits for fresh data.
const inDesktopApp = () => typeof window !== "undefined" && "hive" in window;

/** Hidden pages must not keep fetching data; refresh once on return instead of replaying missed ticks. */
export function visibleInterval(ms: number, tick: () => void, page: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document, applies: () => boolean = inDesktopApp): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const idle = () => page.hidden && applies();
  const pulse = () => { if (!stopped && !idle()) tick(); };
  const sync = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (stopped || idle()) return;
    timer = setInterval(pulse, ms);
  };
  const changed = () => {
    sync();
    pulse();
  };
  page.addEventListener("visibilitychange", changed);
  sync();
  return () => {
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    page.removeEventListener("visibilitychange", changed);
  };
}
