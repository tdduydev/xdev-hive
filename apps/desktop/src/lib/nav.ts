import {
  BotIcon,
  CoinsIcon,
  CpuIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderGitIcon,
  GlobeIcon,
  type LucideIcon,
  MonitorIcon,
  PlayIcon,
  SettingsIcon,
  ZapIcon,
} from "lucide-react";
import type { Dict } from "@/lib/i18n.ts";

/**
 * Hồ sơ menu của app. Một app cho mọi người: mục hiện hay ẩn theo quyền, không tách app.
 * Ánh xạ từ vai trò hub (specs/008-desktop-v2/spec.md): lead = owner/admin tổ chức hoặc admin đội, dev = thành viên
 * đội, writer = người xem đội. Hồ sơ chỉ quyết định menu; mọi thao tác ghi vẫn do hub kiểm.
 */
export type Profile = "dev" | "writer" | "lead";

export type Permission =
  | "docs.read"
  | "docs.write"
  | "docs.propose"
  | "skills.read"
  | "skills.write"
  | "skills.sync"
  | "tokens.read"
  | "env.manage"
  | "runs.local";

/*
 * Writer chỉ đọc tài liệu: người xem đội chỉ đọc trong hub, cho tới khi vai trò tự tạo (specs/001-custom-roles) có quyền
 * viết tài liệu. `docs.propose`: gửi đề xuất sửa tài liệu để người duyệt quyết. Hub nhận đề xuất của thành viên đội trở
 * lên (knowledge/access.ts), không nhận của người xem, nên dev có mà writer không.
 */
const PERMISSIONS: Record<Profile, readonly Permission[]> = {
  dev: ["docs.read", "docs.propose", "skills.read", "skills.sync", "tokens.read", "env.manage", "runs.local"],
  writer: ["docs.read", "skills.read", "tokens.read"],
  lead: [
    "docs.read",
    "docs.write",
    "docs.propose",
    "skills.read",
    "skills.write",
    "skills.sync",
    "tokens.read",
    "env.manage",
    "runs.local",
  ],
};

export type ScreenId =
  | "home"
  | "runs"
  | "remote"
  | "plans"
  | "skills"
  | "memory"
  | "tokens"
  | "projects"
  | "setup"
  | "docs"
  | "settings";

export interface NavItem {
  id: ScreenId;
  label: Dict<string>;
  icon: LucideIcon;
  /** Quyền cần để thấy mục; không có thì ai cũng thấy. */
  needs?: Permission;
  /** Có quyền xem mà thiếu quyền này thì mục hiện nhãn "chỉ đọc". */
  writes?: Permission;
  /** Màn chỉ có dữ liệu trên hub: chưa đăng nhập thì hiện lời mời kết nối Hive thay cho màn. */
  hub?: true;
}

export interface NavGroup {
  id: "machine" | "run" | "agent" | "project";
  /** Tên nhóm: tiêu đề nhỏ trên nhóm (ẩn khi menu chỉ còn icon) và tên cho trình đọc màn hình. */
  label: Dict<string>;
  /** Nhóm đứng đầu chỉ có một mục: không vẽ tiêu đề, mục tự nói tên. */
  untitled?: true;
  items: readonly NavItem[];
}

/*
 * App chỉ giữ việc của chính máy này (người dùng chốt 16/10/2026): việc của đội (bảng việc, duyệt, Leader, AI SDLC, tài
 * liệu của đội) chỉ còn trên web; app báo bằng thông báo Windows và mở đúng trang web. Menu gom theo việc người dùng làm
 * trên máy: chạy, agent, dự án.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "machine",
    label: { vi: "Máy này", en: "This machine" },
    untitled: true,
    items: [{ id: "home", label: { vi: "Máy này", en: "This machine" }, icon: MonitorIcon }],
  },
  {
    id: "run",
    label: { vi: "Chạy", en: "Runs" },
    items: [
      {
        id: "runs",
        label: { vi: "Lượt chạy", en: "Runs" },
        icon: PlayIcon,
        needs: "runs.local",
        hub: true,
      },
      {
        // Cho điện thoại mở và xem phiên terminal của máy này (specs/010-hive-cli-remote). Bật hay tắt chỉ làm được tại máy.
        id: "remote",
        label: { vi: "Điều khiển từ xa", en: "Remote control" },
        icon: GlobeIcon,
        needs: "runs.local",
      },
    ],
  },
  {
    id: "agent",
    label: { vi: "Agent", en: "Agents" },
    items: [
      {
        // Gói đăng ký (tài khoản Claude Code, Codex) worker của máy này chia run cho, như trang Gói agent của app v1.
        id: "plans",
        label: { vi: "Gói agent", en: "Agent plans" },
        icon: BotIcon,
        needs: "runs.local",
      },
      {
        id: "skills",
        label: { vi: "Skills", en: "Skills" },
        icon: ZapIcon,
        needs: "skills.read",
        writes: "skills.sync",
      },
      { id: "memory", label: { vi: "Memory", en: "Memory" }, icon: DatabaseIcon, needs: "tokens.read" },
      {
        id: "tokens",
        label: { vi: "Token và ngữ cảnh", en: "Tokens & context" },
        icon: CoinsIcon,
        needs: "tokens.read",
      },
    ],
  },
  {
    id: "project",
    label: { vi: "Dự án", en: "Projects" },
    items: [
      {
        // Dự án hub gắn với repo trên máy và toàn quyền theo dự án bật tại máy (ADR 0020).
        id: "projects",
        label: { vi: "Dự án trên máy", en: "Projects on this machine" },
        icon: FolderGitIcon,
        needs: "runs.local",
      },
      { id: "setup", label: { vi: "Môi trường", en: "Environment" }, icon: CpuIcon, needs: "env.manage" },
      {
        // Agent đọc code của thư mục dự án rồi soạn bản nháp; tài liệu của đội soạn trên web.
        id: "docs",
        label: { vi: "Tài liệu từ code", en: "Docs from code" },
        icon: FileTextIcon,
        needs: "docs.read",
        writes: "docs.write",
      },
    ],
  },
];

/** Cài đặt nằm ở chân menu, cạnh "Mở hub trên web", không trong nhóm nào. */
export const SETTINGS_ITEM: NavItem = { id: "settings", label: { vi: "Cài đặt", en: "Settings" }, icon: SettingsIcon };

export const NAV_ITEMS: readonly NavItem[] = [...NAV_GROUPS.flatMap((group) => group.items), SETTINGS_ITEM];

export const can = (profile: Profile, permission: Permission): boolean => PERMISSIONS[profile].includes(permission);

export type VisibleNavItem = NavItem & { readOnly: boolean };

const visible = (profile: Profile, item: NavItem) => !item.needs || can(profile, item.needs);

/** Nhóm có mục người dùng được thấy, kèm cờ chỉ đọc; nhóm không còn mục nào thì bỏ để không treo tiêu đề trống. */
export function navGroups(
  profile: Profile,
  groups: readonly NavGroup[] = NAV_GROUPS,
): (Omit<NavGroup, "items"> & { items: VisibleNavItem[] })[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => visible(profile, item))
        .map((item) => ({ ...item, readOnly: item.writes !== undefined && !can(profile, item.writes) })),
    }))
    .filter((group) => group.items.length > 0);
}

/** Mục người dùng được thấy, theo thứ tự trên menu (Cài đặt ở chân menu, sau cùng). */
export function navItems(profile: Profile): VisibleNavItem[] {
  return [...navGroups(profile).flatMap((group) => group.items), { ...SETTINGS_ITEM, readOnly: false }];
}

/** Màn theo `#/<id>`; đường dẫn lạ (kể cả màn đã chuyển sang web như `#/work`) về Máy này. */
export function screenFromHash(hash: string): ScreenId {
  const id = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  return NAV_ITEMS.some((item) => item.id === id) ? (id as ScreenId) : "home";
}
