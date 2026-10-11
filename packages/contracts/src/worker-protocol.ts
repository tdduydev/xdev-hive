import { z } from "zod";

/** Phiên bản giao thức worker ↔ hub (docs/architecture.md mục 5). Tăng khi đổi gói theo cách không tương thích. */
export const PROTOCOL_VERSION = 1;

const machineId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const cli = z.enum(["claude", "codex", "gemini"]);

export const hello = z.object({
  type: z.literal("hello"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(64),
  machineId,
  version: z.string().max(40),
  // Hai bên thoả thuận trong khoảng này để worker cũ hơn hub vẫn chạy được.
  protoRange: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
  os: z.enum(["darwin", "linux", "windows"]),
  clis: z.array(cli).max(10),
  capacity: z.number().int().min(0).max(64),
  resumeRuns: z.array(z.string().max(64)).max(64).default([]),
});

export const welcome = z.object({
  type: z.literal("welcome"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  sessionId: z.string(),
  heartbeatSec: z.number().int().min(5).max(300),
  accessTokenExp: z.iso.datetime(),
});

export const upgradeRequired = z.object({
  type: z.literal("upgrade_required"),
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  url: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sig: z.string(),
});

/** Các gói khác (heartbeat, job_offer, lease, run_event…) thêm ở M3. */
export const workerToHub = z.discriminatedUnion("type", [hello]);
export const hubToWorker = z.discriminatedUnion("type", [welcome, upgradeRequired]);
export type WorkerToHub = z.output<typeof workerToHub>;
export type HubToWorker = z.output<typeof hubToWorker>;
