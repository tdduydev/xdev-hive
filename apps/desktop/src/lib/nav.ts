import {
  BlocksIcon,
  ChartColumnIcon,
  ChartLineIcon,
  ClipboardCheckIcon,
  FilePenLineIcon,
  FileTextIcon,
  FolderGitIcon,
  HouseIcon,
  LayersIcon,
  LibraryIcon,
  ListTodoIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  PlayIcon,
  ServerIcon,
  SmartphoneIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import type { Dict } from "@/lib/i18n.ts";

/**
 * Hồ sơ menu của app (AppNav.dc.html). Một app cho mọi người: mục hiện hay ẩn theo quyền, không tách app.
 * Ánh xạ từ vai trò hub (specs/008-desktop-v2/spec.md): lead = owner/admin tổ chức hoặc admin đội, dev = thành viên
 * đội, writer = người xem đội. Hồ sơ chỉ quyết định menu; mọi thao tác ghi vẫn do hub kiểm.
 */
export type Profile = "dev" | "writer" | "lead";

export type Permission =
  | "sdlc.use"
  | "sdlc.manage"
  | "docs.read"
  | "docs.write"
  | "docs.propose"
  | "skills.read"
  | "skills.write"
  | "skills.sync"
  | "tokens.read"
  | "env.manage"
  | "runs.local"
  | "work.mine"
  | "artifacts.use"
  | "leader.use";

/*
 * Theo AppNav.dc.html, trừ writer: thiết kế cho writer `docs.write`, nhưng người xem đội chỉ đọc trong hub, nên
 * writer chỉ đọc tài liệu cho tới khi vai trò tự tạo (specs/001-custom-roles) có quyền viết tài liệu.
 * `docs.propose`: gửi đề xuất sửa tài liệu để người duyệt quyết. Hub nhận đề xuất của thành viên đội trở lên
 * (knowledge/access.ts), không nhận của người xem, nên dev có mà writer không. `work.mine` (Việc của tôi): giao task
 * cho agent cũng chỉ thành viên đội trở lên, nên writer không có.
 */
const PERMISSIONS: Record<Profile, readonly Permission[]> = {
  dev: [
    "sdlc.use",
    "docs.read",
    "docs.propose",
    "skills.read",
    "skills.sync",
    "tokens.read",
    "env.manage",
    "runs.local",
    "work.mine",
    "artifacts.use",
    "leader.use",
  ],
  writer: ["sdlc.use", "docs.read", "skills.read", "tokens.read", "artifacts.use"],
  lead: [
    "sdlc.use",
    "sdlc.manage",
    "docs.read",
    "docs.write",
    "docs.propose",
    "skills.read",
    "skills.write",
    "skills.sync",
    "tokens.read",
    "env.manage",
    "runs.local",
    "work.mine",
    "artifacts.use",
    "leader.use",
  ],
};

export type ScreenId =
  | "sdlc"
  | "sdlc-questions"
  | "sdlc-progress"
  | "sdlc-metrics"
  | "home"
  | "work"
  | "leader"
  | "artifacts"
  | "reviews"
  | "knowledge"
  | "docs"
  | "write"
  | "skills"
  | "tokens"
  | "memory"
  | "setup"
  | "plans"
  | "projects"
  | "runs"
  | "remote";

export interface NavItem {
  id: ScreenId;
  label: Dict<string>;
  icon: LucideIcon;
  /** File thiết kế của màn, ghi trên trang "Sắp có". */
  design: string;
  /** Quyền cần để thấy mục. */
  needs: Permission;
  /** Có quyền xem mà thiếu quyền này thì mục hiện nhãn "chỉ đọc". */
  writes?: Permission;
  /** Màn chỉ có dữ liệu trên hub: chưa đăng nhập thì hiện lời mời kết nối Hive thay cho màn. */
  hub?: true;
  /** Tính năng hub có thể chưa có (hub cũ): hub báo không có thì ẩn mục, chưa biết thì vẫn hiện. */
  feature?: keyof HubFeatures;
}

/** `false` là hub đã trả lời mà không có tính năng; thiếu khoá là chưa biết (chưa kết nối hay chưa dò xong). */
export type HubFeatures = { artifacts?: boolean };

export interface NavGroup {
  id: "work" | "docs" | "machine" | "sdlc";
  /** Tiêu đề nhỏ trên nhóm, ẩn khi menu chỉ còn icon. */
  label: Dict<string>;
  items: readonly NavItem[];
}

/*
 * Mười mục để phẳng thì dài và tên dễ lẫn (hai mục cùng chữ "Tài liệu"), nên gom theo việc người dùng đang làm: việc
 * của mình, tài liệu của đội, rồi những gì chỉ nằm trên máy này.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "work",
    label: { vi: "Công việc", en: "Work" },
    items: [
      {
        id: "home",
        label: { vi: "Tổng quan", en: "Overview" },
        icon: HouseIcon,
        design: "AppHome.dc.html",
        needs: "docs.read",
      },
      {
        // Task mình tạo hoặc có run mình giao, và run mình giao (spec 008 US10). Bảng việc của cả đội ở web quản trị.
        id: "work",
        label: { vi: "Việc của tôi", en: "My work" },
        icon: ListTodoIcon,
        design: "AppWork.dc.html",
        needs: "work.mine",
        hub: true,
      },
      {
        // Phiên duyệt tài liệu đang chờ mình ở checkpoint hiện tại (spec 008 US11). Ai đọc được tài liệu cũng có thể
        // được chỉ định duyệt; hub quyết ai được quyết.
        id: "reviews",
        label: { vi: "Chờ tôi duyệt", en: "Awaiting my review" },
        icon: ClipboardCheckIcon,
        design: "DocReview.dc.html",
        needs: "docs.read",
        hub: true,
      },
      {
        // Trò chuyện với Leader: duyệt đề xuất, mở artifact Leader tạo (spec 012 US6).
        id: "leader",
        label: { vi: "Leader", en: "Leader" },
        icon: MessagesSquareIcon,
        design: "AppLeader.dc.html",
        needs: "leader.use",
        hub: true,
      },
      {
        id: "artifacts",
        label: { vi: "Artifact", en: "Artifacts" },
        icon: LayersIcon,
        design: "AppArtifacts.dc.html",
        needs: "artifacts.use",
        hub: true,
        feature: "artifacts",
      },
    ],
  },
  {
    id: "sdlc",
    label: { vi: "AI SDLC", en: "AI SDLC" },
    items: [
      {
        id: "sdlc",
        label: { vi: "Hạng mục", en: "Items" },
        icon: BlocksIcon,
        design: "AppSdlcBoard.dc.html",
        needs: "sdlc.use",
        hub: true,
      },
      {
        id: "sdlc-questions",
        label: { vi: "Câu hỏi chờ tôi", en: "Questions for me" },
        icon: MessageCircleQuestionIcon,
        design: "AppSdlcQuestions.dc.html",
        needs: "sdlc.use",
        hub: true,
      },
      {
        id: "sdlc-progress",
        label: { vi: "Tiến độ", en: "Progress" },
        icon: ChartLineIcon,
        design: "AppSdlcBoard.dc.html",
        needs: "sdlc.use",
        hub: true,
      },
      {
        id: "sdlc-metrics",
        label: { vi: "Chỉ số", en: "Metrics" },
        icon: ChartColumnIcon,
        design: "AppSdlcMetrics.dc.html",
        needs: "sdlc.use",
        hub: true,
      },
    ],
  },
  {
    id: "docs",
    label: { vi: "Tài liệu", en: "Docs" },
    items: [
      {
        // Tìm tài liệu đã duyệt, memory và skill của đội khi đang làm việc, chỉ đọc (spec 008 US12).
        id: "knowledge",
        label: { vi: "Tra cứu tri thức", en: "Knowledge" },
        icon: LibraryIcon,
        design: "AppKnowledge.dc.html",
        needs: "docs.read",
        hub: true,
      },
      {
        // Trình soạn tài liệu dùng chung với web (packages/doc-editor, spec 008 US9). Ai đọc được tài liệu đều mở được;
        // hub quyết định sửa hay chỉ đọc và bình luận.
        id: "write",
        label: { vi: "Soạn tài liệu", en: "Write docs" },
        icon: FilePenLineIcon,
        design: "DocEditor.dc.html",
        needs: "docs.read",
        hub: true,
      },
      {
        // Agent đọc code của thư mục dự án rồi soạn bản nháp; nhãn nói rõ nguồn để không lẫn với Soạn tài liệu.
        id: "docs",
        label: { vi: "Tài liệu từ code", en: "Docs from code" },
        icon: FileTextIcon,
        design: "AppDocs.dc.html",
        needs: "docs.read",
        writes: "docs.write",
      },
    ],
  },
  {
    id: "machine",
    label: { vi: "Máy này", en: "This machine" },
    items: [
      {
        // Gói đăng ký (tài khoản Claude Code, Codex) worker của máy này chia run cho, như trang Gói agent của app v1.
        id: "plans",
        label: { vi: "Gói agent", en: "Agent plans" },
        icon: ServerIcon,
        design: "AppNav.dc.html",
        needs: "runs.local",
      },
      {
        // Dự án hub gắn với repo trên máy và toàn quyền theo dự án bật tại máy (ADR 0020).
        id: "projects",
        label: { vi: "Dự án trên máy", en: "Projects on this machine" },
        icon: FolderGitIcon,
        design: "AppNav.dc.html",
        needs: "runs.local",
      },
      {
        id: "runs",
        label: { vi: "Lượt chạy trên máy", en: "Runs on this machine" },
        icon: PlayIcon,
        design: "AppNav.dc.html",
        needs: "runs.local",
        hub: true,
      },
      {
        // Cho điện thoại mở và xem phiên terminal của máy này (specs/010-hive-cli-remote). Bật hay tắt chỉ làm được tại máy.
        id: "remote",
        label: { vi: "Điều khiển từ xa", en: "Remote control" },
        icon: SmartphoneIcon,
        design: "AppRemote.dc.html",
        needs: "runs.local",
      },
      {
        id: "setup",
        label: { vi: "Môi trường", en: "Environment" },
        icon: WrenchIcon,
        design: "AppSetup.dc.html",
        needs: "env.manage",
      },
      {
        id: "skills",
        label: { vi: "Skills", en: "Skills" },
        icon: ZapIcon,
        design: "AppSkills.dc.html",
        needs: "skills.read",
        writes: "skills.sync",
      },
      {
        id: "tokens",
        label: { vi: "Token và ngữ cảnh", en: "Tokens & context" },
        icon: ChartLineIcon,
        design: "AppTokens.dc.html",
        needs: "tokens.read",
      },
      {
        id: "memory",
        label: { vi: "Memory", en: "Memory" },
        icon: LibraryIcon,
        design: "AppNav.dc.html",
        needs: "tokens.read",
      },
    ],
  },
];

export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

export const can = (profile: Profile, permission: Permission): boolean => PERMISSIONS[profile].includes(permission);

export type VisibleNavItem = NavItem & { readOnly: boolean };

/** Nhóm có mục người dùng được thấy, kèm cờ chỉ đọc; nhóm không còn mục nào thì bỏ để không treo tiêu đề trống. */
export function navGroups(
  profile: Profile,
  groups: readonly NavGroup[] = NAV_GROUPS,
  features: HubFeatures = {},
): (Omit<NavGroup, "items"> & { items: VisibleNavItem[] })[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => can(profile, item.needs) && !(item.feature && features[item.feature] === false))
        .map((item) => ({ ...item, readOnly: item.writes !== undefined && !can(profile, item.writes) })),
    }))
    .filter((group) => group.items.length > 0);
}

/** Mục người dùng được thấy, theo thứ tự trên menu. */
export function navItems(profile: Profile, features: HubFeatures = {}): VisibleNavItem[] {
  return navGroups(profile, NAV_GROUPS, features).flatMap((group) => group.items);
}

/** Màn theo `#/<id>` (phần sau `/` tiếp theo là tham số của màn, vd. `#/write/<key>`); mặc định Tổng quan. */
export function screenFromHash(hash: string): ScreenId {
  const id = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  return NAV_ITEMS.some((item) => item.id === id) ? (id as ScreenId) : "home";
}

/** Tham số của màn trong `#/<id>/<tham số>`, đã giải mã; rỗng khi không có. */
export function screenParam(hash: string): string {
  const rest = hash.replace(/^#\/?/, "").split("/").slice(1).join("/");
  try {
    return decodeURIComponent(rest);
  } catch {
    return "";
  }
}
