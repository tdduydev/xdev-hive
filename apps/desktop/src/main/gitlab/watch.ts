// Follows the merge requests the app opened: their state and pipeline on GitLab, and the same for GitHub pull
// requests (state and checks). A merged one moves its task to done (unless turned off), a closed one to the
// status chosen in the settings (blocked by default), and a merged one also takes its task's worktree and local
// branch off the machine (unless turned off); a failed pipeline, or failed checks, on an open one goes to the CI
// fixer. Only links on the configured GitLab / GitHub, so each token goes nowhere else. No Electron imports.
import { HiveError, PIPELINE_STATUSES, type AgentRun, type MrStatus, type PipelineStatus, type TaskStatus } from "@xdev-hive/core";
import { failureId, githubJobs } from "#desktop/main/github/checks.ts";
import { checksStatus, GitHubClient, pullRef } from "#desktop/main/github/client.ts";
import { tr } from "#desktop/main/i18n.ts";
import { branchFor, cleanupMerged, type CleanupKept, type MergedCleanup } from "#desktop/main/runner/worktree.ts";
import { gitlabJobs, type CiFixer, type CiFixOutcome, type FailedJobs } from "./ci-fix.ts";
import { GitLabClient } from "./client.ts";
import { clipTail, mrActor, mrLabel, type MrHost } from "./mr.ts";

/** MRs of runs older than this are left alone. */
const WATCH_DAYS = 30;

/**
 * Milliseconds until the next MR check, `pollMinutes` after the last one started (0 when that time has passed).
 * Counted from the last check rather than from the settings change, so shortening the period acts at once and
 * lengthening it does not push back a check that is already due. No check yet: the first one waits `firstDelayMs`.
 */
export function mrPollDelay(lastCheckAt: number | null, pollMinutes: number, now: number, firstDelayMs = 30_000): number {
  if (lastCheckAt === null) return firstDelayMs;
  return Math.max(0, lastCheckAt + pollMinutes * 60_000 - now);
}

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
  /** Merged, but the hub refused Done: this machine's account has no Code review, so the task waits in Review. */
  taskNeedsReview: boolean;
  /** What became of the task's worktree and local branch on merge; null when not tried (turned off, not merged). */
  cleanup: MergedCleanup | null;
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
        let seen: {
          status: MrStatus;
          pipeline: PipelineStatus | null;
          pipelineUrl: string | null;
          failed: { id: number; jobs: FailedJobs } | null;
          /** The MR's head commit: what a merge took in. */
          headSha: string | null;
        };
        try {
          if (ref) {
            const mr = await gl!.mergeRequest(ref.project, ref.iid);
            seen = {
              status: mr.state === "merged" ? "merged" : mr.state === "closed" ? "closed" : "opened",
              pipeline: pipelineOf(mr.head_pipeline?.status),
              pipelineUrl: mr.head_pipeline?.web_url ?? null,
              failed: mr.head_pipeline ? { id: mr.head_pipeline.id, jobs: gitlabJobs(gl!, ref.project, mr.head_pipeline.id) } : null,
              headSha: mr.sha ?? null,
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
            seen = {
              status,
              pipeline,
              pipelineUrl,
              failed: id === null ? null : { id, jobs: githubJobs(gh!, pull!.repo, runs ?? [], statuses ?? []) },
              headSha: pr.head.sha ?? null,
            };
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
          taskNeedsReview: false,
          cleanup: null,
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
            const moved = await this.#move(run, move.to, move.line);
            change.taskStatus = moved.status;
            change.taskDone = moved.status === "done";
            change.taskNeedsReview = moved.needsReview;
          } catch (err) {
            change.taskError = (err as Error).message;
          }
        }
        if (status === "merged" && s.mr.cleanupOnMerge) {
          change.cleanup = this.#cleanup(run, seen.headSha);
          if (change.cleanup) change.run = store.get(run.id)!;
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
   * it moved to (null when it did not move), and whether the hub refused Done for want of Code review.
   */
  async #move(run: AgentRun, to: TaskStatus | null, what: string): Promise<{ status: TaskStatus | null; needsReview: boolean }> {
    const stayed = { status: null, needsReview: false };
    const backend = this.#host.backend();
    const actor = mrActor(this.#host);
    const task = (await backend.call("tasks.list", { project: run.project }, actor)).find((t) => t.id === run.taskId);
    // A done task is finished whatever became of this MR (it may have gone in through another one).
    if (!task || task.status === "done") return stayed;
    // tasks.update needs a status, and writing doing back would take the task's lease from whoever holds it.
    if (to === null && task.status === "doing") return stayed;
    // tasks.update replaces the whole note, so the old one goes back with the new lines under it.
    const noted = (...lines: string[]) => clipTail([task.note, ...lines].filter(Boolean).join("\n\n"), 2000);
    const line = `${mrLabel(run)} ${what}`;
    try {
      await backend.call("tasks.update", { id: task.id, status: to ?? task.status, note: noted(line) }, actor);
      return { status: to, needsReview: false };
    } catch (err) {
      if (to !== "done" || !needsCodeReview(err)) throw err;
      // Done is a reviewer's call (roadmap 25). The merge still goes on the note, in the task's own status: that
      // bumps updatedAt, so the task shows again on a reviewer's Today with what is left. Not on a doing task, for
      // the lease, as above.
      if (task.status !== "doing") await backend.call("tasks.update", { id: task.id, status: task.status, note: noted(line, NEEDS_REVIEW_LINE) }, actor);
      return { status: null, needsReview: true };
    }
  }

  /**
   * Takes the merged task's worktree and local branch off this machine (see cleanupMerged), but not while the task
   * has a run queued or going: that run works in them. What happened goes on the run's MR note, so a kept worktree
   * says why on the Board. null: the project is not on this machine.
   */
  #cleanup(run: AgentRun, headSha: string | null): MergedCleanup | null {
    const project = this.#host.projects().find((p) => p.name === run.project);
    if (!project) return null;
    const store = this.#host.store();
    const branch = branchFor(run.taskId);
    const result: MergedCleanup = store.activeForTask(run.project, run.taskId)
      ? { worktree: false, branch: false, kept: "active", reason: null }
      : cleanupMerged(project.repo, run.worktree, branch, headSha);
    const line = cleanupNote(result, branch);
    const now = store.get(run.id)!;
    if (line) store.update(run.id, { mrNote: [now.mrNote, line].filter(Boolean).join(" · ") });
    return result;
  }

  #now(): Date {
    return this.#host.now?.() ?? new Date();
  }

  #since(): string {
    return new Date(this.#now().getTime() - WATCH_DAYS * 86_400_000).toISOString();
  }
}

/** Goes into the team's data (the task note), so it does not follow this machine's language. */
export const NEEDS_REVIEW_LINE = "MR đã merge, chờ người có quyền Review code chuyển Xong.";

/** The hub's answer to Done from an account without Code review (see tasks.update in packages/core/src/sqlite.ts). */
const needsCodeReview = (err: unknown): boolean => err instanceof HiveError && err.code === "forbidden" && err.key === "errors.need.codeReview";

const KEPT_KEYS = {
  noSha: "mrNote.keptNoSha",
  newer: "mrNote.keptNewer",
  dirty: "mrNote.keptDirty",
  active: "mrNote.keptActive",
  failed: "mrNote.keptFailed",
} as const satisfies Record<CleanupKept, string>;

/** One line about a merged MR's cleanup, for the run's MR note and the notification; null when there was nothing to remove. */
export function cleanupNote(c: MergedCleanup, branch: string): string | null {
  if (c.kept) {
    const why = tr(KEPT_KEYS[c.kept], { reason: c.reason ?? "" });
    return c.worktree ? tr("mrNote.cleanedWorktreeKeptBranch", { branch, why }) : tr("mrNote.cleanupKept", { branch, why });
  }
  if (c.worktree && c.branch) return tr("mrNote.cleanedBoth", { branch });
  if (c.worktree) return tr("mrNote.cleanedWorktree");
  if (c.branch) return tr("mrNote.cleanedBranch", { branch });
  return null;
}
