import { useMutation } from "@tanstack/react-query";
import { Icon } from "../components/icons.tsx";
import { Button } from "../components/ui/button.tsx";
import { authClient } from "../lib/auth-client.ts";
import { LOGIN_PATH } from "../lib/redirect.ts";

export function SignOutButton() {
  const signOut = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut();
      if (error) throw error;
    },
    // Tải lại cả trang thay vì điều hướng trong app: xoá sạch cache query và state còn giữ dữ liệu tổ chức của người vừa ra.
    onSuccess: () => window.location.assign(LOGIN_PATH),
  });
  const label = signOut.isError ? "Không đăng xuất được, bấm để thử lại" : "Đăng xuất";
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={signOut.isPending}
      onClick={() => signOut.mutate()}
      className={signOut.isError ? "text-bad" : "text-muted"}
    >
      <Icon name="logout" />
    </Button>
  );
}
