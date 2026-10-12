import { Navigate, Outlet } from "@tanstack/react-router";
import { useOrgs } from "@/shell/org-context.ts";

/**
 * Trang chỉ có nghĩa trong một tổ chức. Route đã chặn khi chưa thuộc tổ chức nào; đây là chốt cho lúc danh sách
 * tổ chức tải lại ra rỗng khi đang ở trang (vd. vừa bị khoá), để trang không chạy với tổ chức không còn.
 */
export function OrgGate() {
  const { current } = useOrgs();
  return current ? <Outlet /> : <Navigate to="/" replace />;
}
