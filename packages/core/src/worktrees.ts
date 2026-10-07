import { z } from "zod";

export const worktreeCleanupSchema = z.object({
  enabled: z.boolean().default(true),
  retentionDays: z.number().int().min(1).max(365).default(30),
  minFreeGb: z.number().min(0).max(1000).default(10),
});
export type WorktreeCleanup = z.output<typeof worktreeCleanupSchema>;

export const worktreeTargetSchema = z.object({
  project: z.string().min(1).max(100),
  path: z.string().min(1).max(2000),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
export type WorktreeTarget = z.output<typeof worktreeTargetSchema>;
export const worktreeEntrySchema = worktreeTargetSchema.extend({
  taskId: z.string().max(100),
  taskStatus: z.enum(["todo", "doing", "review", "done", "blocked"]).nullable(),
  taskUpdatedAt: z.iso.datetime().nullable(),
  branch: z.string().max(300),
  head: z.string().max(64),
  bytes: z.number().nonnegative().nullable(),
  modifiedAt: z.iso.datetime(),
  dirty: z.boolean(),
  merged: z.boolean().nullable(),
  active: z.boolean(),
  error: z.string().max(1000).nullable(),
});
export type WorktreeEntry = z.output<typeof worktreeEntrySchema>;
export const worktreeLogSchema = z.object({
  at: z.iso.datetime(), project: z.string(), taskId: z.string(), path: z.string(),
  reason: z.enum(["manual", "merged", "retention", "lowDisk"]),
  ok: z.boolean(), error: z.string().max(1000).nullable(),
});
export type WorktreeLog = z.output<typeof worktreeLogSchema>;
export const worktreeReportSchema = z.object({
  measuredAt: z.iso.datetime(),
  entries: z.array(worktreeEntrySchema).max(2000),
  totalBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative().nullable(),
  cleanup: worktreeCleanupSchema,
  logs: z.array(worktreeLogSchema).max(50),
  errors: z.array(z.string().max(1000)).max(200),
});
export type WorktreeReport = z.output<typeof worktreeReportSchema>;
export interface WorktreeCommand {
  id: string;
  targets: WorktreeTarget[];
  force: boolean;
  cleanup: WorktreeCleanup | null;
  requestedBy: string;
  requestedAt: string;
  completedAt: string | null;
  results: Array<{ path: string; ok: boolean; error: string | null }>;
}
export interface MachineWorktrees {
  supported: boolean;
  canManage: boolean;
  report: WorktreeReport | null;
  commands: WorktreeCommand[];
}
