import type { Disposable, Event, WindowState } from "vscode";

export interface PollOptions {
  intervalMs?: number;
  maxBackoffMs?: number;
  focused(): boolean;
  onDidChangeWindowState: Event<WindowState>;
  onError?(error: unknown): void;
}

export function poll(action: (signal: AbortSignal) => Promise<void>, options: PollOptions): Disposable {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let failures = 0;
  const interval = options.intervalMs ?? 60_000;
  const schedule = () => {
    if (!disposed && options.focused()) {
      timer = setTimeout(() => void run(), Math.min(interval * 2 ** failures, options.maxBackoffMs ?? 300_000));
    }
  };
  const run = async () => {
    if (disposed || active || !options.focused()) return;
    active = new AbortController();
    const controller = active;
    try {
      await action(controller.signal);
      failures = 0;
    } catch (error) {
      if (!controller.signal.aborted) {
        failures = Math.min(failures + 1, 20);
        options.onError?.(error);
      }
    } finally {
      active = undefined;
      schedule();
    }
  };
  const listener = options.onDidChangeWindowState(({ focused }) => {
    clearTimeout(timer);
    if (focused) void run();
    else active?.abort();
  });
  void run();
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      active?.abort();
      listener.dispose();
    },
  };
}
