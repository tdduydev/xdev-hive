import { z } from "zod";
import { validMergeRef } from "#core/merge-queue.ts";

/** 60b emits this only after every configured check passed AND the batch landed on the target branch. */
export const greenBatchSchema = z.object({
  project: z.string().max(100).regex(/^[a-z0-9][a-z0-9._-]*$/),
  batchId: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  targetBranch: z.string().max(200).refine(validMergeRef).optional(),
  taskIds: z.array(z.string().min(1).max(100)).min(1).max(200).refine(ids => new Set(ids).size === ids.length, "Task IDs must be unique"),
  checks: z.array(z.object({ name: z.string().min(1).max(100), passed: z.literal(true) })).min(1).max(100),
  landed: z.literal(true),
});
export type GreenBatch = z.output<typeof greenBatchSchema>;
export const RELEASE_STEPS = ["prepare", "release", "deploy", "rollout", "checkLogs"] as const;
export type ReleaseStep = typeof RELEASE_STEPS[number];
export interface AutoReleaseRecord {
  project: string;
  batchId: string;
  batch: GreenBatch;
  machine: string;
  state: "waiting" | "queued" | "running" | "succeeded" | "failed" | "rejected";
  gateId: number;
  step: ReleaseStep | null;
  warning: boolean;
  reconciled?: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface AutoReleaseView { releases: AutoReleaseRecord[]; paused: boolean }
