import { Button } from "@xdev-hive/ui/button";
import { Icon } from "@/components/icons.tsx";
import { useSignOut } from "@/shell/use-sign-out.ts";

export function SignOutButton() {
  const signOut = useSignOut();
  const label = signOut.isError ? "Không đăng xuất được, bấm để thử lại" : "Đăng xuất";
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={signOut.isPending}
      onClick={() => signOut.mutate()}
      className={signOut.isError ? "text-destructive" : "text-muted-foreground"}
    >
      <Icon name="logout" />
    </Button>
  );
}
