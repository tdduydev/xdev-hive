import { type BoardFilter, isBoardFilter } from "@/lib/task-board.ts";

/*
 * Kiểm tham số URL của các route nằm riêng khỏi file trang: router cần chúng ngay khi khởi động, còn trang được tải
 * lazy. Để trong file trang thì import validate kéo cả trang vào bundle đầu.
 *
 * Router gộp search thô với kết quả kiểm (`{ ...thô, ...đã kiểm }`), nên khoá không hợp lệ phải trả `undefined` rõ ràng
 * để ghi đè giá trị thô; bỏ khoá đi thì `?tab=la` vẫn tới trang. Khoá `undefined` không được ghi lên URL.
 */

export interface LoginSearch {
  /** Trang muốn vào trước khi bị chuyển về đây. */
  redirect?: string;
  /** Mã lỗi Better Auth gắn vào khi chuyển hướng về sau OAuth/SSO. */
  error?: string;
}

export function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  return {
    ...(typeof search.redirect === "string" ? { redirect: search.redirect } : {}),
    ...(typeof search.error === "string" ? { error: search.error } : {}),
  };
}

export interface ReviewsSearch {
  id?: string;
  /** Tab Code; không có là tab Tài liệu, nên URL cũ `?id=` vẫn mở đúng tài liệu. */
  tab?: "code";
}

/** `?id=<phiên duyệt>` để thông báo và đề xuất dẫn thẳng tới một phiên trong hàng chờ; `tab=code` cho phiên review PR. */
export function validateReviewsSearch(search: Record<string, unknown>): ReviewsSearch {
  return {
    ...(search.tab === "code" ? { tab: "code" as const } : {}),
    ...(typeof search.id === "string" && /^[0-9a-f-]{36}$/i.test(search.id) ? { id: search.id } : {}),
  };
}

export interface WorkflowsSearch {
  /** Khoá dự án nguồn: trang tự dựng bản nháp quy trình code từ cấu hình dự án đó (chưa lưu). */
  duan?: string;
}

export function validateWorkflowsSearch(search: Record<string, unknown>): WorkflowsSearch {
  return typeof search.duan === "string" &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(search.duan) &&
    search.duan.length <= 40
    ? { duan: search.duan }
    : {};
}

export interface LeaderSearch {
  /** Cuộc trò chuyện đang mở; bỏ trống thì mở cuộc mới nhất. */
  thread?: string;
  /** `tree`: tab Cây giao việc (specs/028), để lối mở từ trang task, trang run dẫn thẳng tới cây. */
  view?: "tree" | undefined;
}

export function validateLeaderSearch(search: Record<string, unknown>): LeaderSearch {
  return {
    ...(typeof search.thread === "string" ? { thread: search.thread } : {}),
    view: search.view === "tree" ? "tree" : undefined,
  };
}

export interface SdlcBoardSearch {
  /** Mã dự án lọc sẵn khi mở bảng từ màn Chỉ số. */
  project?: string | undefined;
  /** Mã chế độ lọc sẵn. */
  mode?: string | undefined;
}

/** Trả khoá rõ là undefined khi giá trị sai để ghi đè giá trị thô (router gộp thô với đã kiểm). */
export function validateSdlcBoardSearch(search: Record<string, unknown>): SdlcBoardSearch {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return { project: text(search.project), mode: text(search.mode) };
}

export interface TasksSearch {
  /** Nhóm lọc; không có là "Tất cả". */
  status?: BoardFilter;
  /** Chữ trong ô tìm. */
  q?: string;
}

export function validateTasksSearch(search: Record<string, unknown>): TasksSearch {
  return {
    ...(isBoardFilter(search.status) && search.status !== "all" ? { status: search.status } : {}),
    ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
  };
}

export interface OnboardingSearch {
  /** Bước 2 (tạo đội) và 3 (mời người); không có là bước 1 (tạo tổ chức). */
  buoc?: "doi" | "moi";
  /** Đội vừa tạo ở bước 2, để bước 3 mở thẳng đội đó. */
  doi?: string;
}

export function validateOnboardingSearch(search: Record<string, unknown>): OnboardingSearch {
  return {
    ...(search.buoc === "doi" || search.buoc === "moi" ? { buoc: search.buoc } : {}),
    ...(typeof search.doi === "string" ? { doi: search.doi } : {}),
  };
}

export interface TeamsSearch {
  /** Link cũ /admin/teams?doi=<id> (trước khi đội có trang riêng); route chuyển sang /admin/teams/<id>. */
  doi?: string;
}

export function validateTeamsSearch(search: Record<string, unknown>): TeamsSearch {
  return typeof search.doi === "string" ? { doi: search.doi } : {};
}

/** Tab của trang đội; không có là Tổng quan. */
export type TeamTab = "thanh-vien" | "he-thong";

export function validateTeamSearch(search: Record<string, unknown>): { tab?: TeamTab | undefined } {
  return { tab: search.tab === "thanh-vien" || search.tab === "he-thong" ? search.tab : undefined };
}

/** Tab của trang một thành viên; không có là Tổng quan. */
export type MemberTab = "doi";

export function validateMemberSearch(search: Record<string, unknown>): { tab?: MemberTab | undefined } {
  return { tab: search.tab === "doi" ? search.tab : undefined };
}

export type MembersTab = "dang-hoat-dong" | "loi-moi" | "cho-duyet";

export interface MembersSearch {
  /** Tab đang mở; không có là tab Đang hoạt động. */
  xem?: "loi-moi" | "cho-duyet" | undefined;
}

export function validateMembersSearch(search: Record<string, unknown>): MembersSearch {
  return { xem: search.xem === "loi-moi" || search.xem === "cho-duyet" ? search.xem : undefined };
}

/** `?them=1` mở sẵn hộp thoại thêm máy, cho nút "Đăng ký một máy" ở thẻ Bắt đầu của trang chủ. */
export function validateMachinesSearch(search: Record<string, unknown>): { them?: true } {
  return search.them === true || search.them === 1 || search.them === "1" ? { them: true } : {};
}

/** Tab của trang một máy; không có là Tổng quan. */
export type MachineTab = "goi-agent" | "luot-chay";

export function validateMachineSearch(search: Record<string, unknown>): { tab?: MachineTab | undefined } {
  return { tab: search.tab === "goi-agent" || search.tab === "luot-chay" ? search.tab : undefined };
}

/** Tab của trang một vai trò (/admin/roles/$roleId); không có là Quyền. */
export type RoleTab = "nguoi";

export function validateRoleSearch(search: Record<string, unknown>): { tab?: RoleTab | undefined } {
  return { tab: search.tab === "nguoi" ? search.tab : undefined };
}

/** Tab của /admin/mcp; không có là Tool. */
export type McpTab = "server" | "token";

export function validateMcpSearch(search: Record<string, unknown>): { tab?: McpTab | undefined } {
  return { tab: search.tab === "server" || search.tab === "token" ? search.tab : undefined };
}

/** Tab của /notifications; không có là Hộp thư. */
export type NotificationsTab = "kenh";

export function validateNotificationsSearch(search: Record<string, unknown>): { tab?: NotificationsTab | undefined } {
  return { tab: search.tab === "kenh" ? search.tab : undefined };
}

const pick = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  values.find((item) => item === value);

/** Một chuỗi lọc gửi thẳng lên hub: bỏ chuỗi rỗng, cắt theo giới hạn của hub để URL dán tay không làm hub trả 400. */
const text = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value ? value.slice(0, max) : undefined;

/** Bộ lọc của nhật ký kiểm toán; giá trị như `AuditFilters` của hợp đồng (khoảng 7 ngày là mặc định, không ghi). */
export interface AuditSearch {
  range?: 1 | 30 | 365;
  q?: string;
  actorType?: "user" | "run" | "system";
  area?: "work" | "know" | "proj" | "people" | "agent" | "other";
  source?: "web" | "mcp" | "hub";
  result?: "ok" | "denied";
  actorId?: string;
  action?: string;
}

/** Bộ lọc nằm trong URL (admin-layout.md § Thanh lọc) để gửi được link nhật ký đã lọc cho người khác. */
export function validateAuditSearch(search: Record<string, unknown>): AuditSearch {
  const range = pick(["1", "30", "365"], String(search.range));
  const values = {
    range: range ? (Number(range) as 1 | 30 | 365) : undefined,
    q: text(search.q),
    actorType: pick(["user", "run", "system"], search.actorType),
    area: pick(["work", "know", "proj", "people", "agent", "other"], search.area),
    source: pick(["web", "mcp", "hub"], search.source),
    result: pick(["ok", "denied"], search.result),
    actorId: text(search.actorId),
    action: text(search.action),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as AuditSearch;
}

/** Tab của /knowledge/skills; không có là danh sách skill. */
export type SkillsTab = "de-xuat";

export function validateSkillsSearch(search: Record<string, unknown>): { tab?: SkillsTab | undefined } {
  return { tab: search.tab === "de-xuat" ? search.tab : undefined };
}

/** Tab của /knowledge/memory; không có là Đã duyệt. */
export type MemoryTab = "cho-duyet";

export function validateMemorySearch(search: Record<string, unknown>): { tab?: MemoryTab | undefined } {
  return { tab: search.tab === "cho-duyet" ? search.tab : undefined };
}

/** Tab của /knowledge/proposals; không có là Chờ duyệt. */
export type ProposalsTab = "da-duyet" | "tu-choi" | "tat-ca";

export function validateProposalsSearch(search: Record<string, unknown>): { tab?: ProposalsTab | undefined } {
  return { tab: pick(["da-duyet", "tu-choi", "tat-ca"], search.tab) };
}

/** Tab của trang một đề xuất; không có là Thay đổi. */
export type ProposalTab = "lich-su";

export function validateProposalSearch(search: Record<string, unknown>): { tab?: ProposalTab | undefined } {
  return { tab: search.tab === "lich-su" ? search.tab : undefined };
}

/** Tab của trang một skill; không có là Tổng quan. */
export type SkillTab = "hoc-duoc" | "phien-ban";

export function validateSkillSearch(search: Record<string, unknown>): { tab?: SkillTab | undefined } {
  return { tab: pick(["hoc-duoc", "phien-ban"], search.tab) };
}
