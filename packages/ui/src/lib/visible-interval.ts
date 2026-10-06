/** Hidden pages must not keep fetching data; refresh once on return instead of replaying missed ticks. */
export function visibleInterval(ms: number, tick: () => void, page: Pick<Document, "hidden" | "addEventListener" | "removeEventListener"> = document): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const pulse = () => { if (!stopped && !page.hidden) tick(); };
  const sync = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (stopped || page.hidden) return;
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
