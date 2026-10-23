// Artifact (specs/012, ADR 0023): sản phẩm có phiên bản của agent và người. Module khác chỉ import file này.
export {
  type ArtifactAction,
  type ArtifactErrorDetail,
  accessView,
  artifactError,
  assertCan,
  can,
  type Principal,
  type Reader,
  readerFor,
  readerUserId,
  visibleArtifactsWhere,
} from "./access.ts";
export { isBlobType } from "./blob-types.ts";
export { APP_LIB_BASE, type FrameRoutesDeps, frameRoutes } from "./frame-routes.ts";
export {
  allLinkTargets,
  type DocProposer,
  type LinkTarget,
  provideDocProposer,
  provideLinkTarget,
  provideTerminalHost,
  provideThreadHost,
  type TerminalHost,
  type ThreadHost,
  terminalHostOf,
  threadHostOf,
} from "./hooks.ts";
export { artifactPolicyOf, type OperatorCeilings, operatorCeilings } from "./limits.ts";
export { type ArtifactMcpDeps, registerMcpTools } from "./mcp-tools.ts";
export {
  ARTIFACT_PURGE_QUEUE,
  artifactPurgeQueue,
  purgeArtifacts,
  registerArtifactPurgeWorker,
  revokeOwnerLeftLinks,
} from "./purge.ts";
export { type ArtifactsRouterDeps, artifactsRouter } from "./router.ts";
export {
  artifactFor,
  type CreateOptions,
  compileFor,
  createArtifact,
  getArtifact,
  linkInternal,
  listArtifacts,
  updateArtifact,
  visibleSummaries,
} from "./service.ts";
export { FRAME_TICKET_TTL_SEC, frameTicketKey, signFrameTicket, verifyFrameTicket } from "./ticket.ts";
export { ARTIFACT_UPLOAD_PATH, type ArtifactUploadDeps, handleArtifactUpload } from "./upload.ts";
export {
  type ArtifactDeps,
  type Compiled,
  isSecretBlocked,
  recordSecretBlocked,
  type SecretBlockedError,
} from "./versions.ts";
