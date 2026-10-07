// Pushes a task branch (ai/<task>) and opens or updates its GitLab merge request, or its GitHub pull request
// when the project is on GitHub (same rules, see forgeOf).
//
//   implement ─(reviewAfter)─▶ review ── verdict approve ──▶ MR ready
//                                     └─ changes / unclear ─▶ Draft MR (or skip, per settings)
//   implement (no review, when = after_success) ───────────▶ MR ready
//
// No Electron imports; the desktop passes Electron's net.fetch (system proxy + certificates).
import {
  HiveError,
  MR_WATCHER,
  type Actor,
  type AgentRun,
  type DesktopProject,
  type GitHubSettings,
  type GitLabSettings,
  type HiveBackend,
  type SyncMr,
  type Task,
} from "@xdev-hive/core";
import { git, gitAsync, gitErrorText } from "#desktop/main/git.ts";
import { tr } from "#desktop/main/i18n.ts";
import type { RunStore } from "#desktop/main/runner/store.ts";
import { GitHubClient, type GitHubPull } from "#desktop/main/github/client.ts";
import { GitLabClient, type FetchLike, type GitLabMr } from "./client.ts";
import { mrDescription, mrTitle, parseVerdict, type Verdict } from "./describe.ts";
import { parseRemoteUrl, type RemoteInfo } from "./remote.ts";

export interface MrHost {
  gitlab(): GitLabSettings;
  /** GitHub pull requests; they follow the MR options in gitlab().mr. */
  github?(): GitHubSettings;
  projects(): DesktopProject[];
  backend(): HiveBackend;
  mode(): "local" | "hub";
  store(): RunStore;
  fetch?: FetchLike;
  user?: string;
}

/**
 * What the watcher last saw of an MR, for the next run that points at it: without it the watcher would
 * report the old pipeline again as if it were new.
 */
const watched = (run: AgentRun | null): Partial<AgentRun> =>
  run ? { mrStatus: run.mrStatus, pipelineStatus: run.pipelineStatus, pipelineUrl: run.pipelineUrl, mrCheckedAt: run.mrCheckedAt } : {};

export const clipTail = (s: string, n: number) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);

export type Forge = "gitlab" | "github";

/** GitHub when the project names its repository or its remote is on the GitHub host; GitLab otherwise. */
export function forgeOf(project: DesktopProject, remote: RemoteInfo | null, githubUrl: string): Forge {
  if (project.githubRepo) return "github";
  let host: string;
  try {
    host = new URL(githubUrl).hostname.toLowerCase();
  } catch {
    return "gitlab";
  }
  return remote?.host === host ? "github" : "gitlab";
}

/**
 * Env for a push that never waits for a password prompt or an SSH host-key question. HTTPS to the forge's own
 * host carries its token as a header through env-scoped git config, so it is neither stored in .git/config
 * nor visible in the process list. GitLab takes user oauth2, GitHub x-access-token.
 */
export function pushEnv(remoteUrl: string, remote: RemoteInfo | null, host: string, auth: { user: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15",
  };
  if (remote?.https && remote.host === host) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${new URL(remoteUrl).origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${auth.user}:${auth.token}`).toString("base64")}`,
    });
  }
  return env;
}

interface MrPlan {
  review: AgentRun | null;
  implement: AgentRun | null;
  verdict: Verdict;
  draft: boolean;
  branch: string;
  commits: string[];
}

/**
 * Title and description of the docs merge request (roadmap 38c). Like the text of a task's MR, they are read on
 * the forge by whoever reviews them, so they stay Vietnamese: they are team data, not the app's interface.
 */
const contextMrTitle = (project: string) => `docs(xdev-hive): đồng bộ tài liệu của ${project}`;

const contextMrDescription = (project: string, branch: string) =>
  [
    `Tài liệu dùng chung của dự án \`${project}\` trên xDev Hive, render lại vào repo: \`AGENTS.md\`, \`CLAUDE.md\`, \`docs/decisions.md\`, các \`AGENTS.md\` lồng, \`.claude/rules/xdev-hive/\` và \`.claude/skills/\`.`,
    `Nhánh \`${branch}\` được dựng lại trên nhánh đích ở mỗi lần đồng bộ, nên MR này luôn chỉ chứa phần tài liệu.`,
    "Sửa nội dung ở Hive (trang tài liệu của dự án) rồi đồng bộ lại, đừng sửa trong MR: lần đồng bộ sau sẽ ghi đè.",
    "---\n_Tạo tự động bởi xDev Hive._",
  ].join("\n\n");

/** "PR #7" for a GitHub pull request link, "MR !7" for a GitLab merge request. */
export const mrLabel = (run: Pick<AgentRun, "mrUrl" | "mrIid">): string =>
  /\/pull\/\d+$/.test(run.mrUrl ?? "") ? `PR #${run.mrIid ?? "?"}` : `MR !${run.mrIid ?? "?"}`;

/**
 * Who writes MR links and merges on tasks. Its label lets the hub tell it apart: moving a merged MR's task to done is
 * not approving your own work, since the merge on GitLab or GitHub was someone's review (roadmap 27c).
 */
export const mrActor = (host: MrHost): Actor => ({
  name: host.mode() === "hub" ? MR_WATCHER : `${MR_WATCHER}@${host.user ?? "local"}`,
  role: "agent",
  // On a hub the hub reads the label from x-hive-agent (the name); locally this is what it reads.
  agent: MR_WATCHER,
});

export class MergeRequester {
  readonly #host: MrHost;

  constructor(host: MrHost) {
    this.#host = host;
  }

  /** Runner hook: opens/updates an MR when a finished run makes the task ready. */
  async afterFinish(run: AgentRun): Promise<Partial<AgentRun> | void> {
    const s = this.#host.gitlab();
    if (run.status !== "succeeded" || !this.#configured(run)) return;
    if (run.ciFix) return this.pushFix(run);
    if (!s.mr.enabled) return;
    if (run.role === "plan") return;
    if (run.role === "implement" && (run.reviewAfter || s.mr.when !== "after_success")) return;
    return this.open(run, { manual: false });
  }

  /**
   * A run that fixed a failed pipeline: push the branch, GitLab updates the MR and starts a pipeline.
   * Title and description stay as they are (they describe the task and its review).
   */
  async pushFix(run: AgentRun): Promise<Partial<AgentRun>> {
    const s = this.#host.gitlab();
    const fix = run.ciFix!;
    const project = this.#project(run);
    const { remoteUrl, remote } = this.#remote(project, s.mr.remote);
    // The pull request of a GitHub project, the merge request otherwise: each with its own token.
    const gh = this.#forge(project) === "github" ? this.#host.github?.() : undefined;
    const auth = gh
      ? { host: new GitHubClient(gh.url, gh.token, this.#host.fetch).host, user: "x-access-token", token: gh.token }
      : { host: new GitLabClient(s.url, s.token, this.#host.fetch).host, user: "oauth2", token: s.token };
    await this.#push(project.repo, run.branch ?? `ai/${run.taskId}`, s.mr.remote, pushEnv(remoteUrl, remote, auth.host, auth), auth.token);
    const last = this.#host.store().lastOfMr(fix.mrUrl);
    return { mrUrl: fix.mrUrl, mrIid: fix.mrIid, mrState: "updated", mrDraft: last?.mrDraft ?? false, mrNote: tr("mrNote.ciFixPushed"), ...watched(last) };
  }

  #project(run: AgentRun): DesktopProject {
    const project = this.#host.projects().find((p) => p.name === run.project);
    if (!project) throw new HiveError("not_found", `Dự án ${run.project} chưa được thêm vào app.`, { key: "errors.projectNotAdded", vars: { project: run.project } });
    return project;
  }

  #remote(project: DesktopProject, name: string): { remoteUrl: string; remote: RemoteInfo | null } {
    try {
      const remoteUrl = git(project.repo, ["remote", "get-url", name]);
      return { remoteUrl, remote: parseRemoteUrl(remoteUrl) };
    } catch {
      throw new HiveError("bad_request", `Repo ${project.name} không có remote "${name}".`, { key: "errors.noRemote", vars: { project: project.name, remote: name } });
    }
  }

  /**
   * Whether a sync may put this project's docs in a merge request instead of committing into the checkout
   * (roadmap 38c): there has to be a remote on a forge this app can name the project on (its host, or the
   * project/repo filled in by hand) and a token for it. Anything else keeps the old commit mode.
   */
  canOpenContext(project: DesktopProject): boolean {
    let remote: RemoteInfo | null = null;
    try {
      remote = parseRemoteUrl(git(project.repo, ["remote", "get-url", this.#host.gitlab().mr.remote]));
    } catch {
      return false;
    }
    if (this.#forge(project) === "github") {
      const gh = this.#host.github?.();
      return Boolean(gh?.token && (project.githubRepo || remote?.host === new GitHubClient(gh.url, gh.token, this.#host.fetch).host));
    }
    const s = this.#host.gitlab();
    return Boolean(s.url && s.token && (project.gitlabProject || remote?.host === new GitLabClient(s.url, s.token, this.#host.fetch).host));
  }

  /**
   * The merge request a sync in MR mode fills (roadmap 38c): `branch` has just been rebuilt on the target branch,
   * so it is pushed over whatever was there, and its MR is opened or, when one is already open, updated. No run
   * and no task behind it: nothing to write on a task, and never a draft — these docs come from Hive, not an agent.
   */
  async openContext(project: DesktopProject, branch: string, text?: { title: string; body: string }): Promise<SyncMr> {
    const forge = this.#forge(project);
    if (forge === "github") return this.#contextPull(project, branch, text);
    const s = this.#host.gitlab();
    if (!s.url || !s.token) {
      throw new HiveError("bad_request", "Chưa cấu hình GitLab (URL + token) ở trang Dự án & cài đặt.", { key: "errors.gitlabNotSet" });
    }
    const client = new GitLabClient(s.url, s.token, this.#host.fetch);
    const { remoteUrl, remote } = this.#remote(project, s.mr.remote);
    const projectPath = project.gitlabProject || (remote && remote.host === client.host ? remote.path : null);
    if (!projectPath) {
      throw new HiveError(
        "bad_request",
        `Remote "${s.mr.remote}" không trỏ tới ${client.host}. Điền GitLab project (group/project) cho dự án ${project.name}.`,
        { key: "errors.remoteElsewhere", vars: { remote: s.mr.remote, host: client.host, project: project.name } },
      );
    }
    const env = pushEnv(remoteUrl, remote, client.host, { user: "oauth2", token: s.token });
    if (text) await this.#push(project.repo, branch, s.mr.remote, env, s.token);
    else await this.#pushContext(project.repo, branch, s.mr.remote, env, s.token);

    const gp = await client.project(projectPath);
    const target = project.targetBranch || gp.default_branch;
    if (!target) {
      throw new HiveError("bad_request", `GitLab project ${gp.path_with_namespace} chưa có default branch. Điền target branch cho dự án.`, {
        key: "errors.noDefaultBranch",
        vars: { project: gp.path_with_namespace },
      });
    }
    const title = text?.title ?? contextMrTitle(project.name);
    const description = text?.body ?? contextMrDescription(project.name, branch);
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
    return { url: mr.web_url, iid: mr.iid, branch, state: existing ? "updated" : "created" };
  }

  /** The same on GitHub: the docs branch as a pull request. */
  async #contextPull(project: DesktopProject, branch: string, text?: { title: string; body: string }): Promise<SyncMr> {
    const s = this.#host.gitlab();
    const gh = this.#host.github?.();
    if (!gh?.token) throw new HiveError("bad_request", "Chưa có GitHub token ở trang Dự án & cài đặt.", { key: "errors.githubNotSet" });
    const client = new GitHubClient(gh.url, gh.token, this.#host.fetch);
    const { remoteUrl, remote } = this.#remote(project, s.mr.remote);
    const repoPath = project.githubRepo || (remote && remote.host === client.host ? remote.path : null);
    if (!repoPath) {
      throw new HiveError("bad_request", `Không biết repo GitHub của dự án ${project.name}: điền owner/repo.`, { key: "errors.githubRepoUnknown", vars: { project: project.name } });
    }
    const env = pushEnv(remoteUrl, remote, client.host, { user: "x-access-token", token: gh.token });
    if (text) await this.#push(project.repo, branch, s.mr.remote, env, gh.token);
    else await this.#pushContext(project.repo, branch, s.mr.remote, env, gh.token);

    const repo = await client.repo(repoPath);
    const target = project.targetBranch || repo.default_branch;
    if (!target) {
      throw new HiveError("bad_request", `GitHub repo ${repo.full_name} chưa có default branch. Điền target branch cho dự án.`, {
        key: "errors.noDefaultBranch",
        vars: { project: repo.full_name },
      });
    }
    const title = text?.title ?? contextMrTitle(project.name);
    const body = text?.body ?? contextMrDescription(project.name, branch);
    const existing = (await client.openPulls(repoPath, repo.owner.login, branch))[0];
    const pr = existing
      ? await client.updatePull(repoPath, existing.number, { title, body })
      : await client.createPull(repoPath, { title, body, head: branch, base: target });
    if (s.mr.labels.length) {
      try {
        await client.addLabels(repoPath, pr.number, s.mr.labels);
      } catch {
        // Labels are not what the merge request is for; the sync report says nothing about them.
      }
    }
    return { url: pr.html_url, iid: pr.number, branch, state: existing ? "updated" : "created" };
  }

  /**
   * Pushes the docs branch over the one on the remote: each sync rebuilds it on the target branch, so it never
   * fast-forwards. --force-with-lease reads the remote-tracking ref, which git calls stale unless it was just
   * fetched; without the branch there yet, a plain push creates it (and a rejected one beats a blind force).
   */
  async #pushContext(repo: string, branch: string, remoteName: string, env: Record<string, string>, secret: string): Promise<void> {
    const ref = `refs/remotes/${remoteName}/${branch}`;
    let lease: string | null = null;
    try {
      await gitAsync(repo, ["fetch", "--no-tags", remoteName, `+refs/heads/${branch}:${ref}`], env, 120_000);
      lease = git(repo, ["rev-parse", `${ref}^{commit}`]);
    } catch {
      // No such branch on the remote (first sync), or it could not be read: push without a lease to take.
    }
    await this.#push(repo, branch, remoteName, env, secret, lease);
  }

  #forge(project: DesktopProject): Forge {
    let remote: RemoteInfo | null = null;
    try {
      remote = parseRemoteUrl(git(project.repo, ["remote", "get-url", this.#host.gitlab().mr.remote]));
    } catch {
      // no such remote: open() says so
    }
    return forgeOf(project, remote, this.#host.github?.().url ?? "");
  }

  /** The project's forge has what the app needs: GitLab's URL and token, or a GitHub token. */
  #configured(run: AgentRun): boolean {
    const project = this.#host.projects().find((p) => p.name === run.project);
    if (!project) return false;
    if (this.#forge(project) === "github") return Boolean(this.#host.github?.().token);
    const s = this.#host.gitlab();
    return Boolean(s.url && s.token);
  }

  async open(run: AgentRun, { manual }: { manual: boolean }): Promise<Partial<AgentRun>> {
    const s = this.#host.gitlab();
    const project = this.#project(run);
    const forge = this.#forge(project);
    const gh = forge === "github" ? this.#host.github?.() : undefined;
    if (forge === "github" && !gh?.token) {
      throw new HiveError("bad_request", "Chưa có GitHub token ở trang Dự án & cài đặt.", { key: "errors.githubNotSet" });
    }
    if (forge === "gitlab" && (!s.url || !s.token)) {
      throw new HiveError("bad_request", "Chưa cấu hình GitLab (URL + token) ở trang Dự án & cài đặt.", { key: "errors.gitlabNotSet" });
    }
    if (run.role === "plan") throw new HiveError("bad_request", "Run lập kế hoạch không tạo MR.", { key: "errors.planNoMr" });

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
      return { mrState: "skipped", mrNote: verdict === "changes" ? tr("mrNote.changesSkipped") : tr("mrNote.unclearSkipped") };
    }
    const draft = review !== null && verdict !== "approve";

    const branch = run.branch ?? `ai/${run.taskId}`;
    const base = run.baseSha ?? implement?.baseSha;
    if (!base) throw new HiveError("bad_request", "Run chưa có base commit (worktree chưa được tạo).", { key: "errors.noBaseCommit" });
    let commits: string[];
    try {
      commits = git(project.repo, ["log", "--format=%h %s", `${base}..refs/heads/${branch}`]).split("\n").filter(Boolean);
    } catch (err) {
      const reason = gitErrorText(err);
      throw new HiveError("bad_request", `Không đọc được branch ${branch}: ${reason}`, { key: "errors.branchUnreadable", vars: { branch, reason } });
    }
    if (!commits.length) return { mrState: "skipped", mrNote: tr("mrNote.noCommits") };
    if (forge === "github") return this.#openPull(run, project, gh!, { review, implement, verdict, draft, branch, commits });

    const client = new GitLabClient(s.url, s.token, this.#host.fetch);
    const { remoteUrl, remote } = this.#remote(project, s.mr.remote);
    const projectPath = project.gitlabProject || (remote && remote.host === client.host ? remote.path : null);
    if (!projectPath) {
      throw new HiveError(
        "bad_request",
        `Remote "${s.mr.remote}" không trỏ tới ${client.host}. Điền GitLab project (group/project) cho dự án ${project.name}.`,
        { key: "errors.remoteElsewhere", vars: { remote: s.mr.remote, host: client.host, project: project.name } },
      );
    }

    await this.#push(project.repo, branch, s.mr.remote, pushEnv(remoteUrl, remote, client.host, { user: "oauth2", token: s.token }), s.token);

    const gp = await client.project(projectPath);
    const target = project.targetBranch || gp.default_branch;
    if (!target) {
      throw new HiveError("bad_request", `GitLab project ${gp.path_with_namespace} chưa có default branch. Điền target branch cho dự án.`, {
        key: "errors.noDefaultBranch",
        vars: { project: gp.path_with_namespace },
      });
    }

    const backend = this.#host.backend();
    const actor = mrActor(this.#host);
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

    let note: string | null = draft ? (verdict === "changes" ? tr("mrNote.draftChanges") : tr("mrNote.draftUnclear")) : null;
    try {
      await this.#noteOnTask(backend, actor, task, `MR !${mr.iid}${draft ? " (draft)" : ""}`, mr.web_url);
    } catch (err) {
      note = [note, tr("mrNote.taskLinkFailed", { reason: (err as Error).message })].filter(Boolean).join(" · ");
    }
    const seen = existing ? watched(this.#host.store().lastOfMr(mr.web_url)) : {};
    return { mrUrl: mr.web_url, mrIid: mr.iid, mrState: existing ? "updated" : "created", mrDraft: draft, mrNote: note, ...seen };
  }

  /** The same on GitHub: a pull request, a draft one when the review asks for changes. */
  async #openPull(run: AgentRun, project: DesktopProject, gh: GitHubSettings, plan: MrPlan): Promise<Partial<AgentRun>> {
    const s = this.#host.gitlab();
    const client = new GitHubClient(gh.url, gh.token, this.#host.fetch);
    const { remoteUrl, remote } = this.#remote(project, s.mr.remote);
    const repoPath = project.githubRepo || (remote && remote.host === client.host ? remote.path : null);
    if (!repoPath) {
      throw new HiveError("bad_request", `Không biết repo GitHub của dự án ${project.name}: điền owner/repo.`, { key: "errors.githubRepoUnknown", vars: { project: project.name } });
    }
    await this.#push(project.repo, plan.branch, s.mr.remote, pushEnv(remoteUrl, remote, client.host, { user: "x-access-token", token: gh.token }), gh.token);

    const repo = await client.repo(repoPath);
    const target = project.targetBranch || repo.default_branch;
    if (!target) {
      throw new HiveError("bad_request", `GitHub repo ${repo.full_name} chưa có default branch. Điền target branch cho dự án.`, {
        key: "errors.noDefaultBranch",
        vars: { project: repo.full_name },
      });
    }
    const backend = this.#host.backend();
    const actor = mrActor(this.#host);
    const task = (await backend.call("tasks.list", { project: run.project }, actor)).find((t) => t.id === run.taskId) ?? null;
    const text = { taskId: run.taskId, taskTitle: task?.title ?? run.taskTitle };
    const body = mrDescription({
      project: run.project,
      ...text,
      branch: plan.branch,
      commits: plan.commits,
      implement: plan.implement ? { runId: plan.implement.id, profileId: plan.implement.profileId, summary: plan.implement.summary } : null,
      review: plan.review ? { runId: plan.review.id, profileId: plan.review.profileId, summary: plan.review.summary, verdict: plan.verdict } : null,
    });

    const notes: string[] = [];
    let draft = plan.draft;
    const existing = (await client.openPulls(repoPath, repo.owner.login, plan.branch))[0];
    let pr: GitHubPull;
    if (existing) {
      pr = await client.updatePull(repoPath, existing.number, { title: mrTitle(text, false), body });
      if (Boolean(existing.draft) !== draft) {
        try {
          await client.setDraft(existing.node_id, draft);
        } catch (err) {
          draft = Boolean(existing.draft);
          notes.push(tr("mrNote.draftNotChanged", { reason: (err as Error).message }));
        }
      }
    } else {
      try {
        pr = await client.createPull(repoPath, { title: mrTitle(text, false), body, head: plan.branch, base: target, draft });
      } catch (err) {
        // Some plans have no draft pull requests (private repositories on GitHub Free): a ready one says it in its title.
        if (!draft || !/draft/i.test((err as Error).message)) throw err;
        pr = await client.createPull(repoPath, { title: mrTitle(text, true), body, head: plan.branch, base: target });
        notes.push(tr("mrNote.noDraftPulls"));
      }
    }
    if (s.mr.labels.length) {
      try {
        await client.addLabels(repoPath, pr.number, s.mr.labels);
      } catch (err) {
        notes.push(tr("mrNote.labelsFailed", { reason: (err as Error).message }));
      }
    }
    if (draft) notes.unshift(plan.verdict === "changes" ? tr("mrNote.draftChanges") : tr("mrNote.draftUnclear"));
    try {
      await this.#noteOnTask(backend, actor, task, `PR #${pr.number}${draft ? " (draft)" : ""}`, pr.html_url);
    } catch (err) {
      notes.push(tr("mrNote.taskLinkFailed", { reason: (err as Error).message }));
    }
    return { mrUrl: pr.html_url, mrIid: pr.number, mrState: existing ? "updated" : "created", mrDraft: draft, mrNote: notes.join(" · ") || null };
  }

  /** `lease`: the remote's commit this push may replace (roadmap 38c); without one the push must fast-forward. */
  async #push(repo: string, branch: string, remoteName: string, env: Record<string, string>, secret: string, lease?: string | null): Promise<void> {
    const force = lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : [];
    try {
      await gitAsync(repo, ["push", ...force, remoteName, `refs/heads/${branch}:refs/heads/${branch}`], env, 120_000);
    } catch (err) {
      const text = gitErrorText(err).replaceAll(secret, "***");
      throw new HiveError("bad_request", `git push ${remoteName} ${branch} thất bại: ${text}`, { key: "errors.pushFailed", vars: { remote: remoteName, branch, reason: text } });
    }
  }

  async #noteOnTask(backend: HiveBackend, actor: Actor, task: Task | null, label: string, url: string): Promise<void> {
    if (!task || (task.note ?? "").includes(url)) return;
    const line = `${label}: ${url}`;
    await backend.call("tasks.update", { id: task.id, status: task.status, note: clipTail(task.note ? `${task.note}\n\n${line}` : line, 2000) }, actor);
  }
}
