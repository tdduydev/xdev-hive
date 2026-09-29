// A failed pipeline on an open merge request (or failed checks on a GitHub pull request) queues a run that
// fixes it on the same branch, with the end of each failed job's log; the fixed branch is pushed back
// (MergeRequester.pushFix). At most mr.maxCiFixes per MR; each pipeline gets one fix. No Electron imports.
import { findSecret, stripHidden, type AgentRun, type CiFix, type StartRunRequest } from "@xdev-hive/core";
import type { GitLabClient } from "./client.ts";
import type { MrHost } from "./mr.ts";

export interface CiFixHost extends MrHost {
  enqueue(req: StartRunRequest, extra: { ciFix: CiFix }): Promise<AgentRun>;
}

/** Where the failed jobs of one pipeline come from: GitLab jobs, or GitHub check runs (github/checks.ts). */
export interface FailedJobs {
  /** The jobs that failed for real (allowed failures left out). */
  list(): Promise<Array<{ id: number; name: string; stage: string; url: string }>>;
  /** The raw end of one job's log; "" when there is none. */
  log(job: { id: number }): Promise<string>;
}

/** A GitLab pipeline's failed jobs and their traces. */
export function gitlabJobs(client: GitLabClient, project: string, pipelineId: number): FailedJobs {
  return {
    list: async () =>
      (await client.failedJobs(project, pipelineId)).filter((j) => !j.allow_failure).map((j) => ({ id: j.id, name: j.name, stage: j.stage, url: j.web_url })),
    log: (job) => client.jobTrace(project, job.id),
  };
}

export type CiFixOutcome =
  | { kind: "queued"; run: AgentRun; n: number; max: number }
  | { kind: "limit"; max: number }
  | { kind: "error"; reason: string };

/** Log text for the prompt: no colour codes or GitLab section markers, no hidden characters, no secret-looking lines. */
export function cleanLog(raw: string, maxChars: number): string {
  const lines = raw
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/section_(?:start|end):\d+:[\w.-]+(?:\[[^\]\r\n]*\])?\r?/g, "")
    .split("\n")
    // Progress output rewrites its line with \r: keep what was shown last.
    .map((l) => stripHidden(l.replace(/\r+$/, "").split("\r").at(-1) ?? ""))
    .map((l) => {
      const hit = findSecret(l);
      return hit ? `(line hidden: it looked like a ${hit})` : l;
    });
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.length > 500 ? `${lines[i]!.slice(0, 500)}…` : lines[i]!;
    if (size + line.length + 1 > maxChars) break;
    out.unshift(line);
    size += line.length + 1;
  }
  return out.length < lines.length ? `…\n${out.join("\n")}` : out.join("\n");
}

/** Log budget for all jobs together: the prompt goes on the command line (Windows allows about 32k characters). */
const LOG_CHARS = 9000;
const MAX_JOBS = 3;

export class CiFixer {
  readonly #host: CiFixHost;
  /** Pipelines whose fix could not be queued (task done…): not tried again until the app restarts. */
  readonly #failed = new Set<string>();

  constructor(host: CiFixHost) {
    this.#host = host;
  }

  /**
   * For an open MR whose latest pipeline failed. null: nothing to do now (turned off, pipeline already
   * handled, or the task has a run going, which is tried again on the next check).
   */
  async handle(run: AgentRun, pipeline: { id: number; url: string | null }, source: FailedJobs): Promise<CiFixOutcome | null> {
    const s = this.#host.gitlab();
    const mrUrl = run.mrUrl;
    const key = `${mrUrl}#${pipeline.id}`;
    if (!s.mr.fixCi || !mrUrl || this.#failed.has(key)) return null;
    const store = this.#host.store();
    const fixed = store.ciFixedPipelines(mrUrl);
    if (fixed.includes(pipeline.id)) return null;
    if (store.activeForTask(run.project, run.taskId)) return null;
    const max = s.mr.maxCiFixes;
    if (fixed.length >= max) return { kind: "limit", max };
    try {
      const jobs = (await source.list()).slice(0, MAX_JOBS);
      const budget = Math.floor(LOG_CHARS / Math.max(1, jobs.length));
      const ciFix: CiFix = {
        mrUrl,
        mrIid: run.mrIid,
        pipelineId: pipeline.id,
        pipelineUrl: pipeline.url,
        n: fixed.length + 1,
        max,
        jobs: await Promise.all(
          jobs.map(async (j) => ({
            name: j.name,
            stage: j.stage,
            url: j.url,
            log: cleanLog(await source.log(j).catch(() => ""), budget),
          })),
        ),
      };
      const next = await this.#host.enqueue({ project: run.project, taskId: run.taskId, role: "implement", reviewAfter: false }, { ciFix });
      return { kind: "queued", run: next, n: ciFix.n, max };
    } catch (err) {
      this.#failed.add(key);
      return { kind: "error", reason: (err as Error).message };
    }
  }
}
