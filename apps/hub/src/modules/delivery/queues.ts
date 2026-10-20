import type { JobQueue } from "../platform/index.ts";

/** Đọc Jenkins theo lịch cho mỗi kết nối (plan.md mục 4); `singletonKey` là id kết nối. */
export const DELIVERY_CI_POLL_QUEUE = "delivery-ci-poll";
/** Chạy một lần triển khai từ queued tới khi giao cho cách triển khai; `singletonKey` là id lần triển khai. */
export const DELIVERY_DEPLOY_QUEUE = "delivery-deploy";
/** Theo dõi lần đang chạy, tự xếp lại bằng `startAfter` (plan.md mục 5). */
export const DELIVERY_DEPLOY_WATCH_QUEUE = "delivery-deploy-watch";
export const DELIVERY_APPROVAL_EXPIRE_QUEUE = "delivery-approval-expire";
export const DELIVERY_LOG_RETENTION_QUEUE = "delivery-log-retention";
/** Đăng ký lại webhook GitLab có thêm pipeline/job events cho dự án có sẵn. */
export const DELIVERY_WEBHOOK_REFRESH_QUEUE = "delivery-webhook-refresh";

/**
 * pg-boss coi job watch là chết nếu 10 giây không có heartbeat, nên hub chết đột ngột giữa lúc đang đọc log thì job được
 * nhận lại trong khoảng một phút thay vì chờ hết hạn mặc định 15 phút.
 */
export const DEPLOY_WATCH_HEARTBEAT_SECONDS = 10;

export const deliveryQueues: JobQueue[] = [
  { name: DELIVERY_CI_POLL_QUEUE, policy: "stately" },
  { name: DELIVERY_DEPLOY_QUEUE, policy: "stately" },
  { name: DELIVERY_DEPLOY_WATCH_QUEUE, policy: "stately", heartbeatSeconds: DEPLOY_WATCH_HEARTBEAT_SECONDS },
  { name: DELIVERY_APPROVAL_EXPIRE_QUEUE, policy: "singleton" },
  { name: DELIVERY_LOG_RETENTION_QUEUE, policy: "singleton" },
  { name: DELIVERY_WEBHOOK_REFRESH_QUEUE, policy: "singleton" },
];
