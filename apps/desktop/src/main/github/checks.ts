// The failed checks of a pull request's head commit, for the CI fixer: GitHub Actions jobs with their log,
// other apps' check runs with what they reported, and failing commit statuses. No Electron imports.
import type { FailedJobs } from "../gitlab/ci-fix.ts";
import { FAILED_CONCLUSIONS as FAILED, type GitHubCheckRun, type GitHubClient, type GitHubStatus } from "./client.ts";

/** Actions logs: a timestamp on every line and ##[group] markers (the step's title stays); errors keep their text. */
export function actionsLog(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ""))
    .filter((l) => !/^##\[endgroup\]/.test(l))
    .map((l) => l.replace(/^##\[group\]/, "").replace(/^##\[(error|warning|notice)\]/, (_m, kind: string) => `${kind}: `))
    .join("\n");
}

/**
 * Which failure this is, so each gets one fix: the lowest id among the failed check runs (then statuses).
 * A new commit, or a re-run that fails again, has new ids. null when nothing failed.
 */
export function failureId(runs: GitHubCheckRun[], statuses: GitHubStatus[]): number | null {
  const ids = [
    ...runs.filter((r) => r.status === "completed" && FAILED.includes(r.conclusion ?? "")).map((r) => r.id),
    ...statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.id),
  ];
  return ids.length ? Math.min(...ids) : null;
}

/** The failed checks of one commit as the CI fixer's jobs. */
export function githubJobs(client: GitHubClient, repo: string, runs: GitHubCheckRun[], statuses: GitHubStatus[]): FailedJobs {
  const failedRuns = runs.filter((r) => r.status === "completed" && FAILED.includes(r.conclusion ?? ""));
  const failedStatuses = statuses.filter((s) => s.state === "failure" || s.state === "error");
  return {
    list: async () => [
      ...failedRuns.map((r) => ({ id: r.id, name: r.name, stage: r.app?.name ?? "check", url: r.html_url })),
      ...failedStatuses.map((s) => ({ id: s.id, name: s.context, stage: "status", url: s.target_url ?? "" })),
    ],
    log: async (job) => {
      const run = failedRuns.find((r) => r.id === job.id);
      if (run?.app?.slug === "github-actions") return actionsLog(await client.jobLog(repo, run.id));
      if (run) return [run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join("\n\n");
      return failedStatuses.find((s) => s.id === job.id)?.description ?? "";
    },
  };
}
