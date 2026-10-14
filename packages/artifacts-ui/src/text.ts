import type { ArtifactScope } from "@xdev-hive/contracts";

type Dict<T> = Record<"vi" | "en", T>;

/** Chữ của màn artifact (ArtifactPanel.dc.html và các màn T021–T023 thêm vào đây). */
export interface ArtifactsText {
  panel: string;
  tabs: string;
  newArtifact: string;
  loading: string;
  retry: string;
  loadError: string;
  empty: string;
  emptyHelp: string;
  offline: string;
  cachedAt: string;
  notCached: string;
  deleted: string;
  newer: (n: number) => string;
  openVersion: (n: number) => string;
  editingNewer: (n: number) => string;
  version: (n: number) => string;
  versions: string;
  latest: string;
  copy: string;
  copied: string;
  copyFailed: string;
  download: string;
  edit: string;
  share: string;
  publicLinks: string;
  fullscreen: string;
  library: string;
  more: string;
  duplicate: string;
  duplicated: string;
  delete: string;
  deleteWarn: string;
  confirmDelete: string;
  cancel: string;
  close: string;
  backChat: string;
  scope: Record<ArtifactScope, string>;
  notice: string;
  stop: string;
  stopped: string;
  reload: string;
  frameTitle: (title: string) => string;
  pageErrors: string;
  compileError: string;
  fix: string;
  missingLeader: string;
  source: string;
  wrap: string;
  unsupported: string;
  tombstoned: string;
  loadImage: string;
  imageBlocked: string;
  open: string;
  unavailable: string;
  cardLabel: (title: string, n: number) => string;
}

export const artifactsText: Dict<ArtifactsText> = {
  vi: {
    panel: "Artifact",
    tabs: "Artifact của cuộc trò chuyện",
    newArtifact: "Có artifact mới",
    loading: "Đang tải…",
    retry: "Thử lại",
    loadError: "Không tải được artifact. Kiểm tra kết nối rồi thử lại.",
    empty: "Chưa có artifact",
    emptyHelp: "Nhờ Leader tạo một artifact để bắt đầu.",
    offline: "Đang offline — kết nối hub để dùng thao tác này.",
    cachedAt: "Đang offline — bản đã tải lúc",
    notCached: "Cần kết nối hub để mở.",
    deleted: "Artifact không còn truy cập được.",
    newer: (n) => `Có bản mới hơn (v${n})`,
    openVersion: (n) => `Mở v${n}`,
    editingNewer: (n) => `Bạn đang sửa bản này. Đã có v${n}; nội dung đang sửa được giữ nguyên.`,
    version: (n) => `v${n}`,
    versions: "Phiên bản",
    latest: "mới nhất",
    copy: "Sao chép",
    copied: "Đã sao chép.",
    copyFailed: "Không sao chép được. Chọn nguồn rồi sao chép tay.",
    download: "Tải về",
    edit: "Sửa",
    share: "Chia sẻ",
    publicLinks: "Link công khai",
    fullscreen: "Mở toàn màn",
    library: "Mở trong thư viện",
    more: "Thêm thao tác",
    duplicate: "Nhân bản thành bản cá nhân",
    duplicated: "Đã nhân bản thành artifact cá nhân.",
    delete: "Xoá artifact…",
    deleteWarn: "Xoá sẽ thu hồi mọi link công khai. Khôi phục được trong 30 ngày.",
    confirmDelete: "Xoá và thu hồi link",
    cancel: "Thôi",
    close: "Đóng khung",
    backChat: "Về cuộc trò chuyện",
    scope: { private: "Cá nhân", project: "Dự án", team: "Đội", org: "Tổ chức" },
    notice: "Nội dung do agent tạo — không nhập mật khẩu hay dữ liệu bí mật.",
    stop: "Dừng trang",
    stopped: "Đã dừng trang. Tải lại để tiếp tục.",
    reload: "Tải lại trang",
    frameTitle: (title) => `Trang của artifact ${title}`,
    pageErrors: "Trang báo lỗi",
    compileError: "Bản này đang lỗi biên dịch. Xem nguồn hoặc nhờ Leader sửa.",
    fix: "Nhờ Leader sửa",
    missingLeader: "Bạn chưa dùng được Leader ở đây.",
    source: "Nguồn",
    wrap: "Ngắt dòng",
    unsupported: "Chưa có trình xem cho loại này. Đang hiện nguồn.",
    tombstoned: "Phiên bản này đã bị xoá vì chứa bí mật.",
    loadImage: "Tải ảnh",
    imageBlocked: "Ảnh ngoài chưa tải để không lộ địa chỉ của bạn.",
    open: "Mở",
    unavailable: "Artifact không còn truy cập được.",
    cardLabel: (title, n) => `Artifact ${title}, phiên bản ${n}`,
  },
  en: {
    panel: "Artifact",
    tabs: "Conversation artifacts",
    newArtifact: "New artifact",
    loading: "Loading…",
    retry: "Retry",
    loadError: "Could not load the artifact. Check your connection and retry.",
    empty: "No artifacts yet",
    emptyHelp: "Ask Leader to create an artifact to get started.",
    offline: "Offline — connect to the hub to use this action.",
    cachedAt: "Offline — downloaded at",
    notCached: "Connect to the hub to open this artifact.",
    deleted: "Artifact is no longer accessible.",
    newer: (n) => `A newer version is available (v${n})`,
    openVersion: (n) => `Open v${n}`,
    editingNewer: (n) => `You are editing this version. v${n} is available; your edits are preserved.`,
    version: (n) => `v${n}`,
    versions: "Versions",
    latest: "latest",
    copy: "Copy",
    copied: "Copied.",
    copyFailed: "Could not copy. Select the source and copy it manually.",
    download: "Download",
    edit: "Edit",
    share: "Share",
    publicLinks: "Public links",
    fullscreen: "Open full screen",
    library: "Open in library",
    more: "More actions",
    duplicate: "Duplicate as private",
    duplicated: "Duplicated as a private artifact.",
    delete: "Delete artifact…",
    deleteWarn: "Deleting revokes all public links. Restore within 30 days.",
    confirmDelete: "Delete and revoke links",
    cancel: "Cancel",
    close: "Close panel",
    backChat: "Back to conversation",
    scope: { private: "Private", project: "Project", team: "Team", org: "Organization" },
    notice: "Agent-generated content — do not enter passwords or secrets.",
    stop: "Stop page",
    stopped: "Page stopped. Reload to continue.",
    reload: "Reload page",
    frameTitle: (title) => `Artifact page ${title}`,
    pageErrors: "Page reported errors",
    compileError: "This version has a compile error. View source or ask Leader to fix it.",
    fix: "Ask Leader to fix",
    missingLeader: "Leader is unavailable to you here.",
    source: "Source",
    wrap: "Wrap lines",
    unsupported: "No viewer for this type yet. Showing source.",
    tombstoned: "This version was deleted because it contained a secret.",
    loadImage: "Load image",
    imageBlocked: "External image not loaded to keep your address private.",
    open: "Open",
    unavailable: "Artifact is no longer accessible.",
    cardLabel: (title, n) => `Artifact ${title}, version ${n}`,
  },
};
