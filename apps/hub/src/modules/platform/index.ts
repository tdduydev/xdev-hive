// Lõi dùng chung cho mọi module. Module khác chỉ import file này, không import file bên trong.

export {
  BLOB_GC_INTERVAL_MS,
  BLOB_GC_QUEUE,
  type BlobRefs,
  blobRefsIn,
  collectBlobs,
  provideBlobRefs,
  registerBlobGc,
} from "./blob-gc.ts";
export {
  BLOB_CHUNK_BYTES,
  type BlobPutOptions,
  type BlobRef,
  type BlobStore,
  createPostgresBlobStore,
} from "./blob-store.ts";
// Sự kiện client (specs/027 US1): fleet dùng cho điểm token máy (ADR 0036), mcp và router oRPC bọc lần ghi.
export {
  CLIENT_EVENT_RETENTION_QUEUE,
  type ClientEventMeta,
  type ClientEventOutcome,
  ClientEventRejected,
  clientEventRetentionQueue,
  purgeClientEvents,
  registerClientEventRetentionWorker,
  withClientEvent,
} from "./client-events.ts";
export {
  type ClientRequest,
  INVALID_KEY_MESSAGE,
  missingKeyCounts,
  noteMissingKey,
  readClientRequest,
  withMetaKey,
} from "./client-request.ts";
export { type ClientWriteRequest, rejectionOf, runClientWrite } from "./client-write.ts";
export {
  type DocStorageLimits,
  type EmbeddingsConfig,
  type HubConfig,
  loadConfig,
  loadDocStorageLimits,
} from "./config.ts";
export type { RequestContext } from "./context.ts";
export { createPool, type TenantContext, type Tx, withTenant } from "./db.ts";
export { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
export { createJobs, type EnqueueOptions, JOBS_SCHEMA, type JobQueue, type JobRun, type Jobs } from "./jobs.ts";
export {
  type BlobReader,
  detectMediaType,
  inspectFileType,
  inspectWordFile,
  WORD_MEDIA_TYPES,
  type WordFormat,
} from "./magic.ts";
export { bootstrapRoles, type RolePasswords, runMigrations } from "./migrate.ts";
export { decryptSecret, encryptSecret, type MasterKey, parseMasterKey, SecretDecryptError } from "./secrets.ts";
