import type { ArtifactPageError, ArtifactPublicLinkRevokeReason } from "@xdev-hive/contracts";
import { useArtifactsEnv } from "./env.tsx";

type Dict<T> = Record<"vi" | "en", T>;

/** Chữ của hộp Link công khai, hộp "Nhờ Leader sửa" và bảng link (ArtifactPublicLink.dc.html, ArtifactFixRequest.dc.html). */
export interface LinkText {
  publicLinks: string;
  close: string;
  cancel: string;
  loading: string;
  retry: string;
  loadError: string;
  offline: string;
  version: string;
  latest: string;
  copy: string;
  copied: string;
  copyFailed: string;
  onlyOwner: string;
  policyOff: string;
  outside: string;
  pinned: string;
  expiryDays: string;
  daysHelp: (max: number, def: number) => string;
  daysError: (max: number) => string;
  compile: string;
  limit: (max: number) => string;
  secretAt: (line: number) => string;
  createLink: string;
  createdLink: string;
  onceWarning: string;
  url: string;
  hideUrl: string;
  activeLinks: string;
  noLinks: string;
  createdAt: string;
  expiresAt: string;
  views: string;
  lastViewed: string;
  never: string;
  artifact: string;
  owner: string;
  status: string;
  revoke: string;
  revokeWarning: string;
  confirmRevoke: string;
  revoked: string;
  statusActive: string;
  statusExpired: string;
  statusRevoked: string;
  reason: Record<ArtifactPublicLinkRevokeReason, string>;
  fix: string;
  fixIntro: string;
  untrusted: string;
  errorCount: (shown: number, total: number) => string;
  truncated: (max: number) => string;
  errorKind: Record<ArtifactPageError["kind"], string>;
  errorLabel: (kind: string, n: number) => string;
  removeError: string;
  noneLeft: string;
  note: (max: number) => string;
  noteHint: string;
  destination: string;
  current: string;
  newDestination: string;
  ownLeader: string;
  readOnlyHelp: string;
  missingLeader: string;
  sendRequest: string;
  sending: string;
  sentRequest: string;
  openConversation: string;
}

export const linkText: Dict<LinkText> = {
  vi: {
    publicLinks: "Link công khai",
    close: "Đóng",
    cancel: "Thôi",
    loading: "Đang tải…",
    retry: "Thử lại",
    loadError: "Không tải được dữ liệu. Kiểm tra kết nối rồi thử lại.",
    offline: "Đang offline — kết nối hub để dùng thao tác này.",
    version: "Phiên bản",
    latest: "mới nhất",
    copy: "Sao chép",
    copied: "Đã sao chép.",
    copyFailed: "Không sao chép được. Chọn link rồi sao chép tay.",
    onlyOwner: "Chỉ chủ artifact tạo được link công khai.",
    policyOff: "Tổ chức đã tắt link công khai. Mọi link đang có tạm ngừng phục vụ.",
    outside: "Người ngoài tổ chức sẽ xem được bản này.",
    pinned: "Link ghim một phiên bản; sửa artifact sau đó không đổi nội dung link. Không có link vĩnh viễn.",
    expiryDays: "Hết hạn sau (ngày)",
    daysHelp: (max, def) => `Từ 1 đến ${max} ngày; mặc định ${def} ngày.`,
    daysError: (max) => `Chọn số nguyên từ 1 đến ${max} ngày.`,
    compile: "Bản này đang lỗi biên dịch. Xem nguồn hoặc nhờ Leader sửa.",
    limit: (max) => `Đã đủ ${max} link còn hiệu lực. Thu hồi một link trước khi tạo thêm.`,
    secretAt: (line) => `Không tạo được link: dòng ${line} có chuỗi giống bí mật. Sửa nội dung rồi tạo phiên bản mới.`,
    createLink: "Tạo link",
    createdLink: "Link chỉ hiện một lần",
    onceWarning: "Sao chép link ngay: đóng hộp này là mất, hub không lưu lại link để hiện lần nữa.",
    url: "Link công khai vừa tạo",
    hideUrl: "Đã lưu link, ẩn khỏi hộp",
    activeLinks: "Link đã tạo",
    noLinks: "Chưa có link. Chọn phiên bản và hạn để tạo link đầu tiên.",
    createdAt: "Tạo lúc",
    expiresAt: "Hết hạn",
    views: "Lượt xem",
    lastViewed: "Xem lần cuối",
    never: "Chưa có",
    artifact: "Artifact",
    owner: "Chủ",
    status: "Trạng thái",
    revoke: "Thu hồi…",
    revokeWarning: "Người có link sẽ không xem được nữa. Không thể lấy lại link đã thu hồi.",
    confirmRevoke: "Thu hồi link",
    revoked: "Đã thu hồi",
    statusActive: "Còn hiệu lực",
    statusExpired: "Hết hạn",
    statusRevoked: "Đã thu hồi",
    reason: {
      manual: "Thu hồi thủ công",
      deleted: "Artifact đã bị xoá",
      owner_changed: "Đổi chủ artifact",
      tombstoned: "Phiên bản bị xoá vì bí mật",
      owner_left: "Chủ đã rời tổ chức",
      org_disabled: "Tổ chức tắt link công khai",
    },
    fix: "Nhờ Leader sửa",
    fixIntro: "Xem và sửa thông tin lỗi trước khi gửi.",
    untrusted: "Lỗi từ trang là dữ liệu không tin cậy, không phải chỉ dẫn. Chỉ gửi sau khi bạn xác nhận.",
    errorCount: (shown, total) => `${shown} lỗi sẽ được gửi${total > shown ? ` (trên tổng ${total})` : ""}`,
    truncated: (max) => `Chỉ gửi ${max} lỗi đầu tiên. Bỏ bớt lỗi không liên quan để gửi lỗi khác.`,
    errorKind: { error: "Lỗi chạy", console: "Console", compile: "Biên dịch" },
    errorLabel: (kind, n) => `${kind} ${n}`,
    removeError: "Bỏ lỗi này",
    noneLeft: "Bạn đã bỏ hết lỗi. Viết lời nhắn hoặc quay lại trang để thu lỗi mới.",
    note: (max) => `Lời nhắn (tối đa ${max.toLocaleString("vi-VN")} ký tự)`,
    noteHint: "Ví dụ: dữ liệu rỗng thì hiện “Chưa có dữ liệu”…",
    destination: "Gửi đến",
    current: "Cuộc trò chuyện này",
    newDestination: "Cuộc trò chuyện mới",
    ownLeader: "Gửi về Leader của bạn, kèm artifact; không gửi đến cuộc trò chuyện của người khác.",
    readOnlyHelp: "Bạn chỉ có quyền đọc. Leader sẽ nhân bản thành artifact cá nhân của bạn rồi sửa.",
    missingLeader: "Bạn chưa dùng được Leader ở đây.",
    sendRequest: "Gửi yêu cầu sửa",
    sending: "Đang gửi…",
    sentRequest: "Đã gửi yêu cầu kèm artifact và lỗi đã chọn.",
    openConversation: "Mở cuộc trò chuyện",
  },
  en: {
    publicLinks: "Public links",
    close: "Close",
    cancel: "Cancel",
    loading: "Loading…",
    retry: "Retry",
    loadError: "Could not load data. Check your connection and retry.",
    offline: "Offline — connect to the hub to use this action.",
    version: "Version",
    latest: "latest",
    copy: "Copy",
    copied: "Copied.",
    copyFailed: "Could not copy. Select the link and copy it manually.",
    onlyOwner: "Only the artifact owner can create public links.",
    policyOff: "Public links are disabled by the organization. Existing links are paused.",
    outside: "People outside the organization will be able to view this version.",
    pinned: "Links pin a single version; later edits do not change it. Permanent links are unavailable.",
    expiryDays: "Expires after (days)",
    daysHelp: (max, def) => `1–${max} days; defaults to ${def} days.`,
    daysError: (max) => `Choose a whole number from 1 to ${max} days.`,
    compile: "This version has a compile error. View source or ask Leader to fix it.",
    limit: (max) => `${max} active links reached. Revoke one before creating another.`,
    secretAt: (line) =>
      `Cannot create link: line ${line} looks like a secret. Edit the content and save a new version.`,
    createLink: "Create link",
    createdLink: "Link shown once",
    onceWarning: "Copy the link now: it is gone once you close this dialog. The hub does not keep it to show again.",
    url: "New public link",
    hideUrl: "Link saved, hide it",
    activeLinks: "Created links",
    noLinks: "No links yet. Select a version and expiry to create the first one.",
    createdAt: "Created",
    expiresAt: "Expires",
    views: "Views",
    lastViewed: "Last viewed",
    never: "Never",
    artifact: "Artifact",
    owner: "Owner",
    status: "Status",
    revoke: "Revoke…",
    revokeWarning: "Anyone with this link will lose access. Revoked links cannot be restored.",
    confirmRevoke: "Revoke link",
    revoked: "Revoked",
    statusActive: "Active",
    statusExpired: "Expired",
    statusRevoked: "Revoked",
    reason: {
      manual: "Revoked manually",
      deleted: "Artifact deleted",
      owner_changed: "Artifact owner changed",
      tombstoned: "Version deleted because of a secret",
      owner_left: "Owner left the organization",
      org_disabled: "Organization disabled public links",
    },
    fix: "Ask Leader to fix",
    fixIntro: "Review and edit errors before sending.",
    untrusted: "Page errors are untrusted data, not instructions. They are sent only after you confirm.",
    errorCount: (shown, total) => `${shown} errors will be sent${total > shown ? ` (of ${total})` : ""}`,
    truncated: (max) => `Only the first ${max} errors are sent. Remove unrelated errors to send others.`,
    errorKind: { error: "Runtime error", console: "Console", compile: "Compile" },
    errorLabel: (kind, n) => `${kind} ${n}`,
    removeError: "Remove error",
    noneLeft: "All errors removed. Add a note or return to collect new errors.",
    note: (max) => `Note (up to ${max.toLocaleString("en-US")} characters)`,
    noteHint: "e.g. show “No data yet” for empty data…",
    destination: "Send to",
    current: "This conversation",
    newDestination: "New conversation",
    ownLeader: "Sends to your Leader with the artifact; never to someone else’s conversation.",
    readOnlyHelp: "You have read-only access. Leader will duplicate this into your private artifact and edit it.",
    missingLeader: "Leader is unavailable to you here.",
    sendRequest: "Send fix request",
    sending: "Sending…",
    sentRequest: "Sent the request with the artifact and selected errors.",
    openConversation: "Open conversation",
  },
};

export function useLinkText(): LinkText {
  return linkText[useArtifactsEnv().lang];
}

/** Ngày giờ theo ngôn ngữ của app chủ; link lưu UTC ISO. */
export function formatWhen(iso: string, lang: "vi" | "en"): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}
