import { ChartLineIcon, FileTextIcon, HouseIcon, type LucideIcon, PlayIcon, WrenchIcon, ZapIcon } from "lucide-react";
import type { Dict } from "@/lib/i18n.ts";

/**
 * Hồ sơ menu của app (AppNav.dc.html). Một app cho mọi người: mục hiện hay ẩn theo quyền, không tách app.
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
 * Theo AppNav.dc.html, trừ writer: thiết kế cho writer `docs.write`, nhưng người xem đội chỉ đọc trong hub, nên
 * writer chỉ đọc tài liệu cho tới khi vai trò tự tạo (specs/001-custom-roles) có quyền viết tài liệu.
 * `docs.propose`: gửi đề xuất sửa tài liệu để người duyệt quyết. Hub nhận đề xuất của thành viên đội trở lên
 * (knowledge/access.ts), không nhận của người xem, nên dev có mà writer không.
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

export type ScreenId = "home" | "docs" | "skills" | "tokens" | "setup" | "runs";

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
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "home",
    label: { vi: "Tổng quan", en: "Overview" },
    icon: HouseIcon,
    design: "AppHome.dc.html",
    needs: "docs.read",
  },
  {
    id: "docs",
    label: { vi: "Tài liệu", en: "Docs" },
    icon: FileTextIcon,
    design: "AppDocs.dc.html",
    needs: "docs.read",
    writes: "docs.write",
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
    id: "setup",
    label: { vi: "Môi trường", en: "Environment" },
    icon: WrenchIcon,
    design: "AppSetup.dc.html",
    needs: "env.manage",
  },
  {
    id: "runs",
    label: { vi: "Lượt chạy trên máy", en: "Runs on this machine" },
    icon: PlayIcon,
    design: "AppNav.dc.html",
    needs: "runs.local",
  },
];

export const can = (profile: Profile, permission: Permission): boolean => PERMISSIONS[profile].includes(permission);

/** Mục người dùng được thấy, kèm cờ chỉ đọc. */
export function navItems(profile: Profile): (NavItem & { readOnly: boolean })[] {
  return NAV_ITEMS.filter((item) => can(profile, item.needs)).map((item) => ({
    ...item,
    readOnly: item.writes !== undefined && !can(profile, item.writes),
  }));
}

/** Màn theo `#/<id>`; mặc định Tổng quan. */
export function screenFromHash(hash: string): ScreenId {
  const id = hash.replace(/^#\/?/, "");
  return NAV_ITEMS.some((item) => item.id === id) ? (id as ScreenId) : "home";
}
