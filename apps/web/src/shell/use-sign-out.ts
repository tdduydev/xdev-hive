import { useMutation } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client.ts";
import { LOGIN_PATH } from "@/lib/redirect.ts";

/** Đăng xuất dùng chung cho nút ở sidebar và mục trong menu người dùng ở thanh trên. */
export function useSignOut() {
  return useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut();
      if (error) throw error;
    },
    // Tải lại cả trang thay vì điều hướng trong app: xoá sạch cache query và state còn giữ dữ liệu tổ chức của người vừa ra.
    // Chỉ chạy khi hub đã huỷ phiên; lỗi thì ở lại trang, vì sang /login lúc phiên còn sống sẽ bị đẩy ngược về app.
    onSuccess: () => window.location.assign(LOGIN_PATH),
  });
}
