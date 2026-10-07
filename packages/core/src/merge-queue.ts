import { z } from "zod";
export const validMergeRef = (ref: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9/_.+-]*$/.test(ref)
  && !ref.includes("..") && !ref.includes("//")
  && !ref.endsWith("/") && !ref.endsWith(".")
  && ref.split("/").every(part => !part.startsWith(".") && !part.endsWith(".lock"));

export const mergeQueueConfigSchema = z.object({
  enabled: z.boolean().default(false),
  machineId: z.string().max(200).nullable().default(null),
  maxBranches: z.number().int().min(1).max(20).default(5),
  waitMinutes: z.number().int().min(0).max(120).default(5),
  target: z.string().max(200).refine(validMergeRef, "Invalid target branch").default("main"),
  mode: z.enum(["push", "mr"]).default("mr"),
  commands: z.array(z.string().trim().min(1).max(2000)).max(20).default([])
});
export type MergeQueueConfig = z.infer<typeof mergeQueueConfigSchema>;
export interface MergeQueueItem {
  taskId: string;
  branch: string;
  runId: string;
  machineId: string;
  readyAt: string;
}
export const mergeOutcomeSchema = z.object({
  taskId: z.string().max(100),
  status: z.enum(["included", "conflict"]),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  reason: z.string().max(16000).default("")
});
export const mergeResultSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
  status: z.enum(["landed", "awaiting", "failed"]),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable().default(null),
  url: z.url({
    protocol: /^https?$/
  }).nullable().default(null),
  step: z.string().max(300),
  log: z.string().max(32000).default(""),
  outcomes: z.array(mergeOutcomeSchema).max(20)
});
export type MergeResult = z.infer<typeof mergeResultSchema>;
export interface MergeBatch {
  id: number;
  project: string;
  machineId: string;
  instance: string;
  config: MergeQueueConfig;
  items: MergeQueueItem[];
  status: "running" | "landed" | "awaiting" | "failed";
  step: string;
  log: string;
  result: MergeResult | null;
  createdAt: string;
}
export interface MergeQueueView {
  config: MergeQueueConfig;
  waiting: MergeQueueItem[];
  batches: MergeBatch[];
}

/** A fresh gate checkout needs its own dependencies before the project's checks can run. */
export const HIVE_GATE_COMMANDS = ["npm ci --prefer-offline", "npm run typecheck", "env -u RTK_DB_PATH npm test", "npm run e2e -w @xdev-hive/web -- ../../.xdev-hive/artifacts/web", "npm run e2e:mobile -w @xdev-hive/web -- ../../.xdev-hive/artifacts/mobile", "npm run build -w @xdev-hive/desktop", "npm run smoke -w @xdev-hive/desktop -- ../../.xdev-hive/artifacts/desktop"];
