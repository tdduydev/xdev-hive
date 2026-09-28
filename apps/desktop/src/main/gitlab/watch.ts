// Follows the merge requests the app opened: their state and pipeline on GitLab. A merged MR moves its
// task to done (unless turned off). Only MRs on the configured GitLab, so the token goes nowhere else.
// No Electron imports.
import { PIPELINE_STATUSES, type AgentRun, type MrStatus, type PipelineStatus } from "@xdev-hive/core";
import { GitLabClient } from "./client.ts";
import { clipTail, mrActor, type MrHost } from "./mr.ts";

/** MRs of runs older than this are left alone. */
const WATCH_DAYS = 30;

export interface MrChange {
  run: AgentRun;
  status: { from: MrStatus | null; to: MrStatus };
  pipeline: { from: PipelineStatus | null; to: PipelineStatus | null };
  /** The task moved to done because the MR was merged. */
  taskDone: boolean;
  /** Why the task could not be moved, if it could not. */
  taskError: string | null;
}

/** Project path and iid of an MR web URL on `baseUrl`; null for any other URL. */
export function mrRef(baseUrl: string, mrUrl: string): { project: string; iid: number } | null {
  const base = baseUrl.replace(/\/+$/, "");
  if (!mrUrl.startsWith(`${base}/`)) return null;
  const m = /^([\w.-]+(?:\/[\w.-]+)+)\/-\/merge_requests\/(\d+)$/.exec(mrUrl.slice(base.length + 1));
  return m ? { project: m[1]!, iid: Number(m[2]) } : null;
}

const pipelineOf = (status: string | undefined): PipelineStatus | null =>
  status && (PIPELINE_STATUSES as readonly string[]).includes(status) ? (status as PipelineStatus) : null;

export class MrWatcher {
  readonly #host: MrHost & { now?: () => Date };
  #busy = false;

  constructor(host: MrHost & { now?: () => Date }) {
    this.#host = host;
  }

  /** Whether there is anything to follow (GitLab set up and an open MR). */
  watching(): boolean {
    const s = this.#host.gitlab();
    return Boolean(s.url && s.token) && this.#host.store().openMrs(this.#since()).length > 0;
  }

  /** Checks every open MR once. A failing MR is skipped until the next check. */
  async check(): Promise<MrChange[]> {
    const s = this.#host.gitlab();
    if (!s.url || !s.token || this.#busy) return [];
    this.#busy = true;
    try {
      const client = new GitLabClient(s.url, s.token, this.#host.fetch);
      const store = this.#host.store();
      const changes: MrChange[] = [];
      for (const run of store.openMrs(this.#since())) {
        const ref = mrRef(client.baseUrl, run.mrUrl!);
        if (!ref) continue;
        let mr;
        try {
          mr = await client.mergeRequest(ref.project, ref.iid);
        } catch {
          continue;
        }
        const status: MrStatus = mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "opened";
        const pipeline = pipelineOf(mr.head_pipeline?.status);
        store.updateMr(run.mrUrl!, {
          mrStatus: status,
          pipelineStatus: pipeline,
          pipelineUrl: mr.head_pipeline?.web_url ?? null,
          mrCheckedAt: this.#now().toISOString(),
        });
        if (status === run.mrStatus && pipeline === run.pipelineStatus) continue;
        const change: MrChange = {
          run: store.get(run.id)!,
          status: { from: run.mrStatus, to: status },
          pipeline: { from: run.pipelineStatus, to: pipeline },
          taskDone: false,
          taskError: null,
        };
        if (status === "merged" && s.mr.doneOnMerge) {
          try {
            change.taskDone = await this.#done(run, mr.iid);
          } catch (err) {
            change.taskError = (err as Error).message;
          }
        }
        changes.push(change);
      }
      return changes;
    } finally {
      this.#busy = false;
    }
  }

  async #done(run: AgentRun, iid: number): Promise<boolean> {
    const backend = this.#host.backend();
    const actor = mrActor(this.#host);
    const task = (await backend.call("tasks.list", { project: run.project }, actor)).find((t) => t.id === run.taskId);
    if (!task || task.status === "done") return false;
    const line = `MR !${iid} merged.`;
    const note = task.note ? `${task.note}\n\n${line}` : line;
    await backend.call("tasks.update", { id: task.id, status: "done", note: clipTail(note, 2000) }, actor);
    return true;
  }

  #now(): Date {
    return this.#host.now?.() ?? new Date();
  }

  #since(): string {
    return new Date(this.#now().getTime() - WATCH_DAYS * 86_400_000).toISOString();
  }
}
