import { Button } from "@xdev-hive/ui/button";
import { LogOutIcon } from "lucide-react";
import { PersonAvatar } from "@/components/person.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useMe } from "@/shell/me-context.ts";
import { useSignOut } from "@/shell/use-sign-out.ts";

const text: Dict<{ account: string; signOut: string; pending: string; failure: string }> = {
  vi: {
    account: "Tài khoản",
    signOut: "Đăng xuất",
    pending: "Đang đăng xuất…",
    failure: "Không đăng xuất được. Thử lại.",
  },
  en: { account: "Account", signOut: "Sign out", pending: "Signing out…", failure: "Could not sign out. Try again." },
};

/**
 * Menu người dùng ở thanh trên. Sidebar thu gọn hoặc đóng (điện thoại) thì nút đăng xuất ở chân sidebar không thấy,
 * còn thanh trên có mặt ở mọi trang trong khung app.
 */
export function UserMenu() {
  const t = useT(text);
  const me = useMe();
  const signOut = useSignOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label={`${t.account}: ${me.name}`} title={me.name} />}
      >
        <PersonAvatar person={me} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {/* Base UI bắt nhãn menu nằm trong nhóm. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="grid">
            <b className="truncate text-sm font-medium text-foreground">{me.name}</b>
            <span className="truncate font-normal">{me.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {/* Không đóng menu khi bấm: lỗi phải hiện ngay tại đây để người dùng thử lại, thay vì biến mất cùng menu. */}
        <DropdownMenuItem
          variant="destructive"
          closeOnClick={false}
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          <LogOutIcon aria-hidden="true" />
          {signOut.isPending ? t.pending : t.signOut}
        </DropdownMenuItem>
        {signOut.isError && (
          <p role="alert" className="px-1.5 py-1 text-xs text-destructive">
            {t.failure}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
