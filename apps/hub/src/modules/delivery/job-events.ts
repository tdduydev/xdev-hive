import type { DeliveryEvent, DeployState, DeployStep } from "@xdev-hive/contracts";

// Biến sự kiện của worker thành trạng thái lần triển khai. Hàm thuần để thử không cần database; phần ghi nằm ở
// worker-jobs.ts. Log không đi qua đây: log nằm trên máy chạy (FR-060), hub chỉ nhận trạng thái.

export interface DeployOutcome {
  state: DeployState;
  steps: DeployStep[];
  external: { label: string; url: string | null } | null;
  health: { ok: boolean; at: string; status: number | null; message: string } | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Trạng thái đã xong thì mọi sự kiện đến sau (kể cả trùng, kể cả đến muộn) bị bỏ. */
const SETTLED: ReadonlySet<DeployState> = new Set([
  "succeeded",
  "failed",
  "failed_needs_review",
  "unknown",
  "canceled",
  "rejected",
  "expired",
]);

export function isSettled(state: DeployState): boolean {
  return SETTLED.has(state);
}

function withStep(steps: DeployStep[], name: string, change: (s: DeployStep) => DeployStep): DeployStep[] {
  const found = steps.some((s) => s.key === name);
  const base: DeployStep[] = found
    ? steps
    : [...steps, { key: name, state: "pending", startedAt: null, finishedAt: null, exitCode: null, message: null }];
  return base.map((s) => (s.key === name ? change(s) : s));
}

export function applyDeliveryEvent(progress: DeployOutcome, event: DeliveryEvent): DeployOutcome {
  if (isSettled(progress.state)) return progress;
  switch (event.type) {
    case "started":
      return progress.state === "running" ? progress : { ...progress, state: "running", startedAt: event.at };
    case "step": {
      const steps = withStep(progress.steps, event.name, (s) => {
        if (event.state === "running") return { ...s, state: "running", startedAt: s.startedAt ?? event.at };
        return {
          ...s,
          state: event.state,
          startedAt: s.startedAt ?? (event.state === "skipped" ? null : event.at),
          finishedAt: event.at,
          exitCode: event.exitCode ?? s.exitCode,
        };
      });
      return { ...progress, steps };
    }
    case "external":
      return { ...progress, external: { label: event.ref, url: event.url ?? null } };
    case "finished": {
      // Bước còn dở khi việc đã dừng: huỷ thì ghi huỷ, lỗi thì bước đang chạy là bước hỏng.
      const steps = progress.steps.map((s): DeployStep => {
        if (s.state === "running") {
          const canceled = event.state === "canceled";
          return {
            ...s,
            state: canceled ? "canceled" : "failed",
            finishedAt: event.at,
            message: event.error?.message ?? s.message,
          };
        }
        if (s.state === "pending") return { ...s, state: event.state === "canceled" ? "canceled" : "skipped" };
        return s;
      });
      return { ...progress, state: event.state, steps, finishedAt: event.at };
    }
  }
}
