// Follows the merge requests the app opened: their state and pipeline on GitLab, and the same for GitHub pull
// requests (state and checks). A merged one moves its task to done (unless turned off), a closed one to the
// status chosen in the settings (blocked by default); a failed pipeline, or
// failed checks, on an open one goes to the CI fixer. Only links on the configured GitLab / GitHub, so each
// token goes nowhere else. No Electron imports.
import { PIPELINE_STATUSES, type AgentRun, type MrStatus, type PipelineStatus, type TaskStatus } from "@xdev-hive/core";
import { failureId, githubJobs } from "#desktop/main/github/checks.ts";
import { checksStatus, GitHubClient, pullRef } from "#desktop/main/github/client.ts";
import { gitlabJobs, type CiFixer, type CiFixOutcome, type FailedJobs } from "./ci-fix.ts";
import { GitLabClient } from "./client.ts";
import { clipTail, mrActor, mrLabel, type MrHost } from "./mr.ts";

/** MRs of runs older than this are left alone. */
const WATCH_DAYS = 30;

export interface MrChange {
  run: AgentRun;
  status: { from: MrStatus | null; to: MrStatus };
  pipeline: { from: PipelineStatus | null; to: PipelineStatus | null };
  /** What the CI fixer did about a failed pipeline. */
  fix: CiFixOutcome | null;
  /** The task moved to done because the MR was merged. */
  taskDone: boolean;
  /** Where the task moved on this change: done on merge, blocked or todo on close; null when it stayed. */
  taskStatus: TaskStatus | null;
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
  readonly #fixer: CiFixer | null;
  #busy = false;

  constructor(host: MrHost & { now?: () => Date }, fixer: CiFixer | null = null) {
    this.#host = host;
    this.#fixer = fixer;
  }

  /** Whether there is anything to follow (GitLab or GitHub set up, and an open MR or PR). */
  watching(): boolean {
    return (this.#gitlab() !== null || this.#github() !== null) && this.#host.store().openMrs(this.#since()).length > 0;
  }

  #gitlab(): GitLabClient | null {
    const s = this.#host.gitlab();
    return s.url && s.token ? new GitLabClient(s.url, s.token, this.#host.fetch) : null;
  }

  #github(): GitHubClient | null {
    const g = this.#host.github?.();
    return g?.url && g.token ? new GitHubClient(g.url, g.token, this.#host.fetch) : null;
  }

  /** Checks every open MR and PR once. One that fails to answer is skipped until the next check. */
  async check(): Promise<MrChange[]> {
    const s = this.#host.gitlab();
    const gl = this.#gitlab();
    const gh = this.#github();
    if ((!gl && !gh) || this.#busy) return [];
    this.#busy = true;
    try {
      const store = this.#host.store();
      const changes: MrChange[] = [];
      for (const run of store.openMrs(this.#since())) {
        const ref = gl ? mrRef(gl.baseUrl, run.mrUrl!) : null;
        const pull = !ref && gh ? pullRef(gh.baseUrl, run.mrUrl!) : null;
        if (!ref && !pull) continue;
        let seen: { status: MrStatus; pipeline: PipelineStatus | null; pipelineUrl: string | null; failed: { id: number; jobs: FailedJobs } | null };
        try {
          if (ref) {
            const mr = await gl!.mergeRequest(ref.project, ref.iid);
            seen = {
              status: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "opened",
              pipeline: pipelineOf(mr.head_pipeline?.status),
              pipelineUrl: mr.head_pipeline?.web_url ?? null,
              failed: mr.head_pipeline ? { id: mr.head_pipeline.id, jobs: gitlabJobs(gl!, ref.project, mr.head_pipeline.id) } : null,
            };
          } else {
            const pr = await gh!.pull(pull!.repo, pull!.number);
            const status: MrStatus = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "opened";
            // Checks only matter while it is open: a merged or closed PR keeps what was seen last.
            const open = status === "opened";
            // A token without the Checks or Commit statuses permission still follows the PR itself.
            const [runs, statuses] = open
              ? await Promise.all([gh!.checkRuns(pull!.repo, pr.head.sha).catch(() => null), gh!.statuses(pull!.repo, pr.head.sha).catch(() => null)])
              : [null, null];
            const pipeline = runs === null && statuses === null ? run.pipelineStatus : checksStatus(runs ?? [], statuses ?? []);
            // Per commit, so a new push whose checks fail again counts as a change.
            const pipelineUrl = !open ? run.pipelineUrl : pipeline ? `${pr.html_url}/checks?sha=${pr.head.sha}` : null;
            const id = pipeline === "failed" ? failureId(runs ?? [], statuses ?? []) : null;
            seen = { status, pipeline, pipelineUrl, failed: id === null ? null : { id, jobs: githubJobs(gh!, pull!.repo, runs ?? [], statuses ?? []) } };
          }
        } catch {
          continue;
        }
        const { status, pipeline, pipelineUrl } = seen;
        store.updateMr(run.mrUrl!, { mrStatus: status, pipelineStatus: pipeline, pipelineUrl, mrCheckedAt: this.#now().toISOString() });
        // A new pipeline that failed like the last one counts as a change (its URL differs).
        const changed = status !== run.mrStatus || pipeline !== run.pipelineStatus || pipelineUrl !== run.pipelineUrl;
        // Asked on every check, not only on a change: a fix waits while the task has a run going.
        const fix =
          this.#fixer && status === "opened" && pipeline === "failed" && seen.failed
            ? await this.#fixer.handle(run, { id: seen.failed.id, url: pipelineUrl }, seen.failed.jobs)
            : null;
        if (!changed && fix?.kind !== "queued") continue;
        const change: MrChange = {
          run: store.get(run.id)!,
          status: { from: run.mrStatus, to: status },
          pipeline: { from: run.pipelineStatus, to: pipeline },
          fix,
          taskDone: false,
          taskStatus: null,
          taskError: null,
        };
        // openMrs only returns MRs last seen open, so a merged or closed status here is always new.
        const move =
          status === "merged" && s.mr.doneOnMerge
            ? { to: "done" as const, line: "merged." }
            : status === "closed"
              ? { to: s.mr.onClosed === "keep" ? null : s.mr.onClosed, line: "closed without merging." }
              : null;
        if (move) {
          try {
            change.taskStatus = await this.#move(run, move.to, move.line);
            change.taskDone = change.taskStatus === "done";
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

  /**
   * Moves the task to `to` (null: keeps its status) and adds a line about the MR to its note. Returns the status
   * it moved to, or null when it did not move.
   */
  async #move(run: AgentRun, to: TaskStatus | null, what: string): Promise<TaskStatus | null> {
    const backend = this.#host.backend();
    const actor = mrActor(this.#host);
    const task = (await backend.call("tasks.list", { project: run.project }, actor)).find((t) => t.id === run.taskId);
    // A done task is finished whatever became of this MR (it may have gone in through another one).
    if (!task || task.status === "done") return null;
    // tasks.update needs a status, and writing doing back would take the task's lease from whoever holds it.
    if (to === null && task.status === "doing") return null;
    const line = `${mrLabel(run)} ${what}`;
    const note = task.note ? `${task.note}\n\n${line}` : line;
    await backend.call("tasks.update", { id: task.id, status: to ?? task.status, note: clipTail(note, 2000) }, actor);
    return to;
  }

  #now(): Date {
    return this.#host.now?.() ?? new Date();
  }

  #since(): string {
    return new Date(this.#now().getTime() - WATCH_DAYS * 86_400_000).toISOString();
  }
}
