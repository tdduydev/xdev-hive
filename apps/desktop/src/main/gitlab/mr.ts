// Pushes a task branch (ai/<task>) and opens or updates its GitLab merge request.
//
//   implement ─(reviewAfter)─▶ review ── verdict approve ──▶ MR ready
//                                     └─ changes / unclear ─▶ Draft MR (or skip, per settings)
//   implement (no review, when = after_success) ───────────▶ MR ready
//
// No Electron imports; the desktop passes Electron's net.fetch (system proxy + certificates).
import {
  HiveError,
  type Actor,
  type AgentRun,
  type DesktopProject,
  type GitLabSettings,
  type HiveBackend,
  type Task,
} from "@xdev-hive/core";
import { git, gitAsync, gitErrorText } from "../git.ts";
import type { RunStore } from "../runner/store.ts";
import { GitLabClient, type FetchLike, type GitLabMr } from "./client.ts";
import { mrDescription, mrTitle, parseVerdict, type Verdict } from "./describe.ts";
import { parseRemoteUrl, type RemoteInfo } from "./remote.ts";

export interface MrHost {
  gitlab(): GitLabSettings;
  projects(): DesktopProject[];
  backend(): HiveBackend;
  mode(): "local" | "hub";
  store(): RunStore;
  fetch?: FetchLike;
  user?: string;
}

const clipTail = (s: string, n: number) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);

export class MergeRequester {
  readonly #host: MrHost;

  constructor(host: MrHost) {
    this.#host = host;
  }

  /** Runner hook: opens/updates an MR when a finished run makes the task ready. */
  async afterFinish(run: AgentRun): Promise<Partial<AgentRun> | void> {
    const s = this.#host.gitlab();
    if (!s.mr.enabled || !s.url || !s.token || run.status !== "succeeded") return;
    if (run.role === "plan") return;
    if (run.role === "implement" && (run.reviewAfter || s.mr.when !== "after_success")) return;
    return this.open(run, { manual: false });
  }

  async open(run: AgentRun, { manual }: { manual: boolean }): Promise<Partial<AgentRun>> {
    const s = this.#host.gitlab();
    if (!s.url || !s.token) throw new HiveError("bad_request", "Chưa cấu hình GitLab (URL + token) ở trang Dự án & cài đặt.");
    if (run.role === "plan") throw new HiveError("bad_request", "Run lập kế hoạch không tạo MR.");
    const project = this.#host.projects().find((p) => p.name === run.project);
    if (!project) throw new HiveError("not_found", `Dự án ${run.project} chưa được thêm vào app.`);

    const store = this.#host.store();
    const review =
      run.role === "review"
        ? run
        : (store.list({ project: run.project, limit: 500 }).find((r) => r.parentRunId === run.id && r.role === "review" && r.status === "succeeded") ?? null);
    const parent = review?.parentRunId ? store.get(review.parentRunId) : null;
    const implement =
      run.role === "implement" ? run : parent?.role === "implement" ? parent : store.lastSucceeded(run.project, run.taskId, "implement");

    const verdict: Verdict = review ? parseVerdict(review.summary) : "none";
    if (!manual && review && verdict !== "approve" && s.mr.onChangesRequested === "skip") {
      return { mrState: "skipped", mrNote: verdict === "changes" ? "Review yêu cầu sửa, chưa tạo MR" : "Review không rõ kết luận, chưa tạo MR" };
    }
    const draft = review !== null && verdict !== "approve";

    const branch = run.branch ?? `ai/${run.taskId}`;
    const base = run.baseSha ?? implement?.baseSha;
    if (!base) throw new HiveError("bad_request", "Run chưa có base commit (worktree chưa được tạo).");
    let commits: string[];
    try {
      commits = git(project.repo, ["log", "--format=%h %s", `${base}..refs/heads/${branch}`]).split("\n").filter(Boolean);
    } catch (err) {
      throw new HiveError("bad_request", `Không đọc được branch ${branch}: ${gitErrorText(err)}`);
    }
    if (!commits.length) return { mrState: "skipped", mrNote: "Branch không có commit mới so với base" };

    const client = new GitLabClient(s.url, s.token, this.#host.fetch);
    let remoteUrl: string;
    try {
      remoteUrl = git(project.repo, ["remote", "get-url", s.mr.remote]);
    } catch {
      throw new HiveError("bad_request", `Repo ${project.name} không có remote "${s.mr.remote}".`);
    }
    const remote = parseRemoteUrl(remoteUrl);
    const projectPath = project.gitlabProject || (remote && remote.host === client.host ? remote.path : null);
    if (!projectPath) {
      throw new HiveError(
        "bad_request",
        `Remote "${s.mr.remote}" không trỏ tới ${client.host}. Điền GitLab project (group/project) cho dự án ${project.name}.`,
      );
    }

    await this.#push(project.repo, branch, s, remoteUrl, remote, client.host);

    const gp = await client.project(projectPath);
    const target = project.targetBranch || gp.default_branch;
    if (!target) throw new HiveError("bad_request", `GitLab project ${gp.path_with_namespace} chưa có default branch. Điền target branch cho dự án.`);

    const backend = this.#host.backend();
    const actor = this.#actor();
    const task = (await backend.call("tasks.list", { project: run.project }, actor)).find((t) => t.id === run.taskId) ?? null;
    const title = mrTitle({ taskId: run.taskId, taskTitle: task?.title ?? run.taskTitle }, draft);
    const description = mrDescription({
      project: run.project,
      taskId: run.taskId,
      taskTitle: task?.title ?? run.taskTitle,
      branch,
      commits,
      implement: implement ? { runId: implement.id, profileId: implement.profileId, summary: implement.summary } : null,
      review: review ? { runId: review.id, profileId: review.profileId, summary: review.summary, verdict } : null,
    });

    const existing = (await client.openMergeRequests(gp.id, branch))[0];
    const mr: GitLabMr = existing
      ? // Keep the target and labels people may have changed in GitLab; only add ours.
        await client.updateMergeRequest(gp.id, existing.iid, { title, description, add_labels: s.mr.labels.join(",") } as never)
      : await client.createMergeRequest(gp.id, {
          source_branch: branch,
          target_branch: target,
          title,
          description,
          labels: s.mr.labels.join(","),
          remove_source_branch: s.mr.removeSourceBranch,
        });

    let note: string | null = draft ? (verdict === "changes" ? "Draft vì review yêu cầu sửa" : "Draft vì review không rõ kết luận") : null;
    try {
      await this.#noteOnTask(backend, actor, task, mr, draft);
    } catch (err) {
      note = [note, `Không ghi được link MR vào task: ${(err as Error).message}`].filter(Boolean).join(" · ");
    }
    return { mrUrl: mr.web_url, mrIid: mr.iid, mrState: existing ? "updated" : "created", mrDraft: draft, mrNote: note };
  }

  #actor(): Actor {
    return { name: this.#host.mode() === "hub" ? "hive-mr" : `hive-mr@${this.#host.user ?? "local"}`, role: "agent" };
  }

  async #push(repo: string, branch: string, s: GitLabSettings, remoteUrl: string, remote: RemoteInfo | null, host: string): Promise<void> {
    // Never wait for a password prompt or an SSH host-key question: fail fast instead of hanging.
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15",
    };
    if (remote?.https && remote.host === host) {
      // HTTPS to our GitLab: authenticate with the token through env-scoped git config,
      // so it is neither stored in .git/config nor visible in the process list.
      const origin = new URL(remoteUrl).origin;
      Object.assign(env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${s.token}`).toString("base64")}`,
      });
    }
    try {
      await gitAsync(repo, ["push", s.mr.remote, `refs/heads/${branch}:refs/heads/${branch}`], env, 120_000);
    } catch (err) {
      const text = gitErrorText(err).replaceAll(s.token, "***");
      throw new HiveError("bad_request", `git push ${s.mr.remote} ${branch} thất bại: ${text}`);
    }
  }

  async #noteOnTask(backend: HiveBackend, actor: Actor, task: Task | null, mr: GitLabMr, draft: boolean): Promise<void> {
    if (!task || (task.note ?? "").includes(mr.web_url)) return;
    const line = `MR !${mr.iid}${draft ? " (draft)" : ""}: ${mr.web_url}`;
    await backend.call("tasks.update", { id: task.id, status: task.status, note: clipTail(task.note ? `${task.note}\n\n${line}` : line, 2000) }, actor);
  }
}
