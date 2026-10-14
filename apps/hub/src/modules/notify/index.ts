// Thông báo cho nhóm quản trị qua Telegram hoặc email. Module khác gọi notify() trong transaction của nghiệp vụ.
export {
  type ChannelRecord,
  createChannel,
  listChannels,
  removeChannel,
  updateChannel,
} from "./channels.ts";
export { type NotifyFanoutInput, provideNotifyFanout } from "./fanout.ts";
export {
  cleanupInbox,
  INBOX_CLEANUP_QUEUE,
  inboxCleanupQueue,
  listInbox,
  markInboxRead,
  registerInboxCleanupWorker,
  unreadInboxCount,
} from "./inbox.ts";
export {
  type DeliverDeps,
  type DeliverOutcome,
  deliverNotification,
  deliverPending,
  MAX_ATTEMPTS,
  NOTIFY_QUEUE,
  type NotifyInput,
  type NotifyJob,
  type NotifyOptions,
  notify,
  notifyQueue,
  registerNotifyWorker,
} from "./notify.ts";
export { inboxRouter, type NotifyDeps, notifyRouter } from "./router.ts";
export { DeliveryError, escapeHtml, type SendDeps, send, telegramText } from "./send.ts";
