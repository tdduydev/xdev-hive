// GitLab integration settings. Browser-safe: the UI edits them with the same schema.
import { z } from "zod";

export const MR_STATES = ["created", "updated", "skipped", "failed"] as const;
export type MrState = (typeof MR_STATES)[number];

/** The merge request's own state on GitLab ("locked" counts as opened). */
export const MR_STATUSES = ["opened", "merged", "closed"] as const;
export type MrStatus = (typeof MR_STATUSES)[number];

/** GitLab's pipeline statuses. */
export const PIPELINE_STATUSES = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "success",
  "failed",
  "canceled",
  "skipped",
  "manual",
  "scheduled",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const mrSettingsSchema = z.object({
  /** Open/update a merge request automatically when a task's work is ready. */
  enabled: z.boolean().default(false),
  /** after_review: when the cross-review finishes. after_success: when the implementing run succeeds without a review. */
  when: z.enum(["after_review", "after_success"]).default("after_review"),
  /** What to do when the review asks for changes (or its verdict is unclear). */
  onChangesRequested: z.enum(["draft", "skip"]).default("draft"),
  labels: z.array(z.string().min(1).max(50)).max(10).default(["ai", "xdev-hive"]),
  removeSourceBranch: z.boolean().default(true),
  /** Git remote to push ai/<task> branches to. */
  remote: z.string().regex(/^[\w.-]{1,50}$/).default("origin"),
  /** The app follows the MRs it opened; a merged one moves its task to done. */
  doneOnMerge: z.boolean().default(true),
  /**
   * Where the task goes when its MR is closed without merging; keep leaves its status. Blocked by default: the
   * work it was waiting on is gone, so it should not look like it is still in review.
   */
  onClosed: z.enum(["blocked", "todo", "keep"]).default("blocked"),
  /**
   * A merged MR removes its task's worktree and local ai/<task> branch, when the branch head is the merged commit
   * and nothing is left uncommitted: otherwise they pile up, one per task, with dependencies and builds in each.
   */
  cleanupOnMerge: z.boolean().default(true),
  /**
   * Minutes between two checks of the open MRs and PRs. 1 at least: each check asks GitLab/GitHub once per open MR,
   * so faster would spend the token's rate limit; 60 at most, or a merge would wait too long to reach its task.
   */
  pollMinutes: z.number().int().min(1).max(60).default(2),
  /** A failed pipeline on an open MR queues a run that fixes it, with the failed jobs' logs. */
  fixCi: z.boolean().default(true),
  /** Automatic fixes per MR; after that a failed pipeline is only reported. */
  maxCiFixes: z.number().int().min(1).max(5).default(2),
});
export type MrSettings = z.output<typeof mrSettingsSchema>;

export const gitlabSettingsSchema = z.object({
  /** e.g. https://gitlab.example.com */
  url: z.string().default(""),
  /** Personal/project access token with `api` scope (and `write_repository` when pushing over HTTPS). */
  token: z.string().default(""),
  mr: mrSettingsSchema.default(mrSettingsSchema.parse({})),
});
export type GitLabSettings = z.output<typeof gitlabSettingsSchema>;

// ── importing a GitLab group (roadmap 19a) ─────────────────────────────────────

/** A repository of a GitLab group, as the import lists it. */
export interface GitLabGroupRepo {
  id: number;
  name: string;
  /** group/sub/name: the project the app opens MRs on. */
  pathWithNamespace: string;
  defaultBranch: string | null;
  sshUrl: string;
  httpUrl: string;
}

/** A repository the import offers: the key it would get, where it would be cloned, and what is already there. */
export interface GitLabImportCandidate {
  repo: GitLabGroupRepo;
  key: string;
  dir: string;
  /** added: a project of this app has it already · folder: the folder exists (used as it is) · new: cloned. */
  state: "added" | "folder" | "new";
}

export interface GitLabImportResult {
  key: string;
  pathWithNamespace: string;
  ok: boolean;
  cloned: boolean;
  error: string | null;
}

/**
 * A Hive project key for a repository: its own name made to fit (lowercase letters, digits, . _ -), and when another
 * project has that key, the name of its group in front, then a number.
 */
export function suggestProjectKey(pathWithNamespace: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[-.]+$/g, "")
      .slice(0, 60) || "repo";
  const parts = pathWithNamespace.split("/").filter(Boolean);
  const own = clean(parts.at(-1) ?? "repo");
  if (!used.has(own)) return own;
  const withGroup = clean(`${parts.at(-2) ?? "group"}-${parts.at(-1) ?? "repo"}`);
  if (!used.has(withGroup)) return withGroup;
  for (let n = 2; ; n++) if (!used.has(`${own}-${n}`)) return `${own}-${n}`;
}
