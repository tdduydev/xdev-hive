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
