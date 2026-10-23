import type { LinkProps } from "@tanstack/react-router";
import {
  ActivityIcon,
  BellIcon,
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  ChartColumnIcon,
  ChartLineIcon,
  CircleHelpIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestArrowIcon,
  HouseIcon,
  KanbanSquareIcon,
  KeyRoundIcon,
  LayersIcon,
  type LucideIcon,
  MessagesSquareIcon,
  MonitorIcon,
  NetworkIcon,
  PlayIcon,
  PlugIcon,
  PlugZapIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
  SmartphoneIcon,
  SparklesIcon,
  SquareStackIcon,
  UserCogIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import type { Dict } from "@/lib/i18n.ts";

type To = NonNullable<LinkProps["to"]>;
/* Màn chưa có trong routeTree khi khai báo lần đầu (vd. do task khác thêm) ép kiểu ở đây. */
const route = (path: string) => path as To;

export interface NavItem {
  id: string;
  label: Dict<string>;
  icon: LucideIcon;
  to: To;
  /** Đường dẫn bắt đầu bằng chuỗi này thì mục sáng lên, kể cả màn con (vd. /runs/<id>). */
  match: string;
  /** Chỉ quản trị tổ chức dùng được; ẩn với người khác trong tổ chức. */
  adminOnly?: boolean;
  /** Quyền của vai trò tự tạo làm mục `adminOnly` hiện ra với người không phải quản trị (vd. audit.read). */
  permission?: string;
  /** Số đếm hiện bên phải mục (vd. PR chờ tôi duyệt); sidebar tự lấy số theo khoá này. */
  badge?: "codeReviews" | "sdlcQuestions";
}

export interface NavGroup {
  id: string;
  label: Dict<string>;
  icon: LucideIcon;
  /**
   * `admin`: nhóm nằm trong menu Quản trị (menu trái thứ hai, admin-layout.md § Decisions), sidebar chính chỉ còn một
   * mục "Quản trị" thay cho các nhóm này.
   */
  area?: "admin";
  items: NavItem[];
}

/** Mục lẻ đầu sidebar (Sidebar.dc.html: "Tổng quan"). */
export const NAV_HOME: NavItem = {
  id: "home",
  label: { vi: "Tổng quan", en: "Overview" },
  icon: HouseIcon,
  to: "/",
  match: "/",
};

/**
 * Cây điều hướng theo Sidebar.dc.html; sidebar, menu Quản trị, bảng lệnh ⌘K và đường dẫn ở Topbar cùng đọc. Nhóm
 * `area: "admin"` xếp theo thứ tự của menu Quản trị.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "work",
    label: { vi: "Công việc", en: "Work" },
    icon: KanbanSquareIcon,
    items: [
      { id: "tasks", label: { vi: "Bảng việc", en: "Board" }, icon: KanbanSquareIcon, to: "/tasks", match: "/tasks" },
      { id: "runs", label: { vi: "Lượt chạy", en: "Runs" }, icon: PlayIcon, to: "/runs", match: "/runs" },
      {
        id: "leader",
        label: { vi: "Leader", en: "Leader" },
        icon: MessagesSquareIcon,
        to: "/leader",
        match: "/leader",
      },
      {
        id: "remote",
        label: { vi: "Điều khiển từ xa", en: "Remote control" },
        icon: SmartphoneIcon,
        to: "/remote",
        match: "/remote",
      },
      {
        id: "artifacts",
        label: { vi: "Artifact", en: "Artifacts" },
        icon: LayersIcon,
        to: "/artifacts",
        match: "/artifacts",
      },
    ],
  },
  {
    id: "sdlc",
    label: { vi: "AI SDLC", en: "AI SDLC" },
    icon: SquareStackIcon,
    items: [
      {
        id: "sdlc-items",
        label: { vi: "Hạng mục", en: "Items" },
        icon: SquareStackIcon,
        to: route("/sdlc"),
        match: "/sdlc",
        adminOnly: true,
        permission: "sdlc.read",
      },
      {
        id: "sdlc-fleet",
        label: { vi: "Đội máy AI SDLC", en: "AI SDLC fleet" },
        to: route("/sdlc/fleet"),
        match: "/sdlc/fleet",
        icon: MonitorIcon,
        adminOnly: true,
        permission: "machines.read",
      },
      {
        id: "sdlc-questions",
        label: { vi: "Câu hỏi chờ tôi", en: "Questions for me" },
        icon: CircleHelpIcon,
        to: route("/sdlc/questions"),
        match: "/sdlc/questions",
        adminOnly: true,
        permission: "sdlc.read",
        badge: "sdlcQuestions",
      },
      {
        id: "sdlc-metrics",
        label: { vi: "Chỉ số", en: "Metrics" },
        icon: ChartLineIcon,
        to: route("/sdlc/metrics"),
        match: "/sdlc/metrics",
        adminOnly: true,
        permission: "sdlc.read",
      },
    ],
  },
  {
    id: "know",
    label: { vi: "Kiến thức", en: "Knowledge" },
    icon: BookOpenIcon,
    items: [
      {
        id: "docs",
        label: { vi: "Tài liệu", en: "Docs" },
        icon: FileTextIcon,
        to: route("/knowledge/docs"),
        match: "/knowledge/docs",
      },
      {
        id: "skills",
        label: { vi: "Skills", en: "Skills" },
        icon: SparklesIcon,
        to: route("/knowledge/skills"),
        match: "/knowledge/skills",
      },
      {
        id: "memory",
        label: { vi: "Memory", en: "Memory" },
        icon: BrainIcon,
        to: route("/knowledge/memory"),
        match: "/knowledge/memory",
      },
      {
        id: "proposals",
        label: { vi: "Đề xuất sửa", en: "Proposals" },
        icon: GitPullRequestArrowIcon,
        to: route("/knowledge/proposals"),
        match: "/knowledge/proposals",
      },
      {
        id: "workflows",
        label: { vi: "Quy trình duyệt", en: "Review workflows" },
        icon: WorkflowIcon,
        to: route("/knowledge/workflows"),
        match: "/knowledge/workflows",
      },
      {
        id: "reviews",
        label: { vi: "Chờ tôi duyệt", en: "Awaiting my review" },
        icon: ClipboardCheckIcon,
        to: route("/knowledge/reviews"),
        match: "/knowledge/reviews",
        badge: "codeReviews",
      },
    ],
  },
  {
    id: "access",
    area: "admin",
    label: { vi: "Người và quyền", en: "People & access" },
    icon: UsersIcon,
    items: [
      {
        id: "members",
        label: { vi: "Thành viên", en: "Members" },
        icon: UsersIcon,
        to: "/admin/members",
        match: "/admin/members",
      },
      {
        id: "teams",
        label: { vi: "Đội và hệ thống", en: "Teams & systems" },
        icon: NetworkIcon,
        to: "/admin/teams",
        match: "/admin/teams",
      },
      {
        id: "roles",
        label: { vi: "Vai trò và quyền", en: "Roles & permissions" },
        icon: UserCogIcon,
        to: route("/admin/roles"),
        match: "/admin/roles",
        adminOnly: true,
        permission: "roles.write",
      },
      {
        id: "signin",
        label: { vi: "Đăng nhập", en: "Sign-in" },
        icon: KeyRoundIcon,
        to: "/admin/sign-in-settings",
        match: "/admin/sign-in-settings",
        adminOnly: true,
        permission: "signin.write",
      },
    ],
  },
  {
    id: "proj",
    area: "admin",
    label: { vi: "Dự án và hạ tầng", en: "Projects & infra" },
    icon: FolderIcon,
    items: [
      { id: "projects", label: { vi: "Dự án", en: "Projects" }, icon: FolderIcon, to: "/projects", match: "/projects" },
      {
        id: "machines",
        label: { vi: "Máy", en: "Machines" },
        icon: MonitorIcon,
        to: route("/machines"),
        match: "/machines",
      },
      {
        id: "git",
        label: { vi: "Kết nối Git", en: "Git connections" },
        icon: GitBranchIcon,
        to: "/admin/git",
        match: "/admin/git",
        adminOnly: true,
      },
      {
        id: "ci-connections",
        label: { vi: "Kết nối CI", en: "CI connections" },
        icon: PlugZapIcon,
        to: route("/admin/ci-connections"),
        match: "/admin/ci-connections",
        adminOnly: true,
        permission: "ci.connections.manage",
      },
      {
        id: "servers",
        label: { vi: "Máy chủ triển khai", en: "Deploy servers" },
        icon: ServerIcon,
        to: route("/admin/servers"),
        match: "/admin/servers",
        adminOnly: true,
        permission: "servers.manage",
      },
      {
        id: "sandbox",
        label: { vi: "Sandbox", en: "Sandbox" },
        icon: ShieldIcon,
        to: "/admin/sandbox",
        match: "/admin/sandbox",
        adminOnly: true,
        permission: "sandbox.read",
      },
    ],
  },
  {
    id: "agents",
    area: "admin",
    label: { vi: "Quản trị agent", en: "Agent governance" },
    icon: BotIcon,
    items: [
      {
        id: "mcp",
        label: { vi: "MCP và công cụ", en: "MCP & tools" },
        icon: PlugIcon,
        to: route("/admin/mcp"),
        match: "/admin/mcp",
        adminOnly: true,
        permission: "mcp.servers",
      },
      {
        id: "sdlc-modes",
        label: { vi: "Chế độ AI SDLC", en: "AI SDLC modes" },
        icon: WorkflowIcon,
        to: route("/admin/sdlc-modes"),
        match: "/admin/sdlc-modes",
        adminOnly: true,
        permission: "sdlc.modes.write",
      },
      {
        id: "policies",
        label: { vi: "Chính sách agent", en: "Agent policies" },
        icon: ShieldCheckIcon,
        to: route("/admin/policies"),
        match: "/admin/policies",
        adminOnly: true,
        permission: "policies.write",
      },
      {
        id: "org-config",
        label: { vi: "Cấu hình tổ chức", en: "Organization configuration" },
        icon: SettingsIcon,
        to: route("/admin/config"),
        match: "/admin/config",
        adminOnly: true,
        permission: "policies.write",
      },
      {
        id: "public-links",
        label: { vi: "Link công khai", en: "Public links" },
        icon: LayersIcon,
        to: route("/admin/public-links"),
        match: "/admin/public-links",
        adminOnly: true,
      },
    ],
  },
  {
    id: "ops",
    area: "admin",
    label: { vi: "Theo dõi", en: "Monitoring" },
    icon: ActivityIcon,
    items: [
      {
        id: "costs",
        label: { vi: "Chi phí và token", en: "Costs & tokens" },
        icon: ChartColumnIcon,
        to: route("/admin/costs"),
        match: "/admin/costs",
      },
      {
        id: "notifications",
        label: { vi: "Thông báo", en: "Notifications" },
        icon: BellIcon,
        to: route("/notifications"),
        match: "/notifications",
      },
      {
        id: "audit",
        label: { vi: "Nhật ký", en: "Audit log" },
        icon: ScrollTextIcon,
        to: route("/admin/audit"),
        match: "/admin/audit",
        adminOnly: true,
        permission: "audit.read",
      },
    ],
  },
];

/** Mục lẻ cuối sidebar chính, mở menu Quản trị (các nhóm `area: "admin"`). */
export const NAV_ADMIN = {
  id: "admin",
  label: { vi: "Quản trị", en: "Admin" } satisfies Dict<string>,
  icon: SettingsIcon,
};

/*
 * Bảng việc của một dự án và màn CI/CD của dự án là màn làm việc, không phải màn quản trị, dù nằm dưới /projects:
 * không hiện menu Quản trị để cột thẻ và bảng build đủ rộng, và sáng mục Bảng việc như /tasks.
 */
const PROJECT_BOARD = /^\/projects\/[^/]+(?:\/(?:cicd|token-usage)(?:\/.*)?)?\/?$/;

/** Mục khớp đường dẫn hiện tại (khớp dài nhất), để sáng mục ở sidebar và hiện tên màn ở Topbar. */
export function activeNavItem(pathname: string): NavItem | undefined {
  const all = [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)];
  if (pathname === "/") return NAV_HOME;
  if (PROJECT_BOARD.test(pathname)) return all.find((item) => item.id === "tasks");
  return all
    .filter((item) => item.match !== "/" && pathname.startsWith(item.match))
    .sort((a, b) => b.match.length - a.match.length)[0];
}

/** Nhóm chứa mục, để thanh trên ghi "tổ chức › nhóm › trang" như sidebar. Tổng quan không thuộc nhóm nào. */
export function navGroupOf(item: NavItem | undefined): NavGroup | undefined {
  return item ? NAV_GROUPS.find((g) => g.items.some((i) => i.id === item.id)) : undefined;
}

/**
 * Lọc mục theo quyền: mục `adminOnly` chỉ hiện với quản trị tổ chức, hoặc người có quyền `permission` qua vai trò tự
 * tạo. Nhóm rỗng bị bỏ.
 */
export function visibleGroups(isAdmin: boolean, can: (permission: string) => boolean = () => false): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.adminOnly || isAdmin || (i.permission !== undefined && can(i.permission))),
  })).filter((g) => g.items.length > 0);
}

/** Đường dẫn thuộc một mục của menu Quản trị: khung app hiện menu trái thứ hai và sáng mục "Quản trị". */
export function inAdminArea(pathname: string): boolean {
  return navGroupOf(activeNavItem(pathname))?.area === "admin";
}

/** Nơi mục "Quản trị" của sidebar chính dẫn tới: mục đầu tiên người dùng được thấy trong menu Quản trị. */
export function adminHome(groups: readonly NavGroup[]): NavItem | undefined {
  return groups.find((g) => g.area === "admin")?.items[0];
}
