// CI/CD và triển khai (specs/020): theo dõi pipeline/build, máy chủ SSH, môi trường, đích và lần triển khai.

export { deliveryOutbound, setDeliveryOutbound } from "./clients/outbound.ts";
export {
  auditSecretUse,
  type InfraAuth,
  infraAuth,
  infraTokenContext,
  type JenkinsAuth,
  type JenkinsAuthInput,
  jenkinsAuth,
  jenkinsTokenContext,
  SECRET_USED_ACTION,
  type SecretUse,
} from "./connections/credentials.ts";
export {
  type DeployMethod,
  type DeployMethodContext,
  DeployMethodNotImplementedError,
  type DeployProgress,
  type DeployRun,
  type DeployStarted,
} from "./deploys/method.ts";
export { deployMethods, methodFor } from "./deploys/methods.ts";
export type { DeliveryDeps, DeliveryRouteDeps } from "./deps.ts";
export {
  DELIVERY_APPROVAL_EXPIRE_QUEUE,
  DELIVERY_CI_POLL_QUEUE,
  DELIVERY_DEPLOY_QUEUE,
  DELIVERY_DEPLOY_WATCH_QUEUE,
  DELIVERY_LOG_RETENTION_QUEUE,
  DELIVERY_WEBHOOK_REFRESH_QUEUE,
  DEPLOY_WATCH_HEARTBEAT_SECONDS,
  deliveryQueues,
  registerDelivery,
} from "./jobs.ts";
export { type DeliveryEvent, type DeliveryEventInput, emitDeliveryEvent } from "./notifications.ts";
export { deliveryRouter } from "./router.ts";
export {
  ciJenkinsConnections,
  ciJenkinsUserTokens,
  ciProjectJobs,
  ciRunsSeen,
  deployApprovals,
  deployConnections,
  deployEnvironments,
  deployLogChunks,
  deployServers,
  deploys,
  deployTargets,
  type HostKey,
} from "./schema.ts";
export { type DeployStreamDeps, deployStreamHandler } from "./stream-route.ts";
