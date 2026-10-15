import { TERMINAL_RUN_STATES } from "@xdev-hive/contracts";
import type { Disposable } from "vscode";

export type TaskRunStatus = { runId: string; kind: "running" | "queued" | "planning" };

type HubTask = { id: string; title: string; status: string; source: Record<string, unknown> };
type HubRun = { id: string; taskId: string | null; state: string };

export interface HubStatusDeps {
  /** Không có token thì không gọi hub; đây là cách giữ lời hứa "chưa đăng nhập thì không có request". */
  signedIn(): Promise<boolean>;
  project(root: string): Promise<string | undefined>;
  tasks(projectId: string, signal: AbortSignal): Promise<HubTask[]>;
  runs(projectId: string, signal: AbortSignal): Promise<HubRun[]>;
}

const ACTIVE: Record<string, TaskRunStatus["kind"]> = {
  running: "running",
  queued: "queued",
  awaiting_plan: "planning",
};

const CODE = /^T\d{3}[a-z]?$/;

/** Mã task tasks.md mà task hub ứng với: theo `source` ({spec, task}), hoặc tiêu đề bắt đầu bằng `<spec>/<mã>`. */
export function taskCode(task: HubTask, spec: string): string | undefined {
  if (task.source.spec === spec && typeof task.source.task === "string" && CODE.test(task.source.task))
    return task.source.task;
  if (!task.title.startsWith(`${spec}/`)) return undefined;
  return /^(T\d{3}[a-z]?)\b/.exec(task.title.slice(spec.length + 1))?.[1];
}

export class HubStatus {
  private readonly deps: HubStatusDeps;
  private readonly roots = new Map<string, { spec: string; code: string; status: TaskRunStatus }[]>();
  private readonly wanted = new Map<string, Set<string>>();
  private signedOut = true;
  private readonly listeners = new Set<() => void>();

  constructor(deps: HubStatusDeps) {
    this.deps = deps;
  }

  get isSignedOut(): boolean {
    return this.signedOut;
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Báo root nào đang có tasks.md mở; chỉ những root này được hỏi hub. Trả về true nếu root mới. */
  watchRoot(root: string, spec: string): boolean {
    const specs = this.wanted.get(root) ?? new Set<string>();
    const isNew = !this.wanted.has(root) || !specs.has(spec);
    specs.add(spec);
    this.wanted.set(root, specs);
    return isNew;
  }

  lookup(root: string, spec: string, code: string): TaskRunStatus | undefined {
    return this.roots.get(root)?.find((entry) => entry.spec === spec && entry.code === code)?.status;
  }

  async refresh(signal: AbortSignal): Promise<void> {
    if (!(await this.deps.signedIn())) {
      const changed = !this.signedOut || this.roots.size > 0;
      this.signedOut = true;
      this.roots.clear();
      if (changed) this.fire();
      return;
    }
    this.signedOut = false;
    for (const [root, specs] of this.wanted) {
      const projectId = await this.deps.project(root);
      if (signal.aborted) return;
      if (!projectId) {
        this.roots.delete(root);
        continue;
      }
      const [tasks, runs] = await Promise.all([this.deps.tasks(projectId, signal), this.deps.runs(projectId, signal)]);
      const found: { spec: string; code: string; status: TaskRunStatus }[] = [];
      for (const task of tasks) {
        const kind = ACTIVE[task.status];
        if (!kind) continue;
        const run = runs.find((r) => r.taskId === task.id && !TERMINAL_RUN_STATES.includes(r.state as never));
        if (!run) continue;
        for (const spec of specs) {
          const code = taskCode(task, spec);
          if (code) found.push({ spec, code, status: { runId: run.id, kind } });
        }
      }
      this.roots.set(root, found);
    }
    this.fire();
  }

  private fire(): void {
    for (const listener of this.listeners) listener();
  }
}
