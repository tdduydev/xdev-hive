import { type BoardFilter, isBoardFilter } from "@/lib/task-board.ts";

/*
 * Kiểm tham số URL của các route nằm riêng khỏi file trang: router cần chúng ngay khi khởi động, còn trang được tải
 * lazy. Để trong file trang thì import validate kéo cả trang vào bundle đầu.
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
}

export function validateLeaderSearch(search: Record<string, unknown>): LeaderSearch {
  return typeof search.thread === "string" ? { thread: search.thread } : {};
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

export function validateTeamSearch(search: Record<string, unknown>): { tab?: TeamTab } {
  return search.tab === "thanh-vien" || search.tab === "he-thong" ? { tab: search.tab } : {};
}

export type MembersTab = "dang-hoat-dong" | "loi-moi" | "cho-duyet";

export interface MembersSearch {
  /** Tab đang mở; không có là tab Đang hoạt động. */
  xem?: "loi-moi" | "cho-duyet";
}

export function validateMembersSearch(search: Record<string, unknown>): MembersSearch {
  return search.xem === "loi-moi" || search.xem === "cho-duyet" ? { xem: search.xem } : {};
}

/** `?them=1` mở sẵn hộp thoại thêm máy, cho nút "Đăng ký một máy" ở thẻ Bắt đầu của trang chủ. */
export function validateMachinesSearch(search: Record<string, unknown>): { them?: true } {
  return search.them === true || search.them === 1 || search.them === "1" ? { them: true } : {};
}
