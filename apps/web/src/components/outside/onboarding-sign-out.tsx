import { useMutation } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { authClient } from "@/lib/auth-client.ts";
import { type Dict, useT } from "@/lib/i18n.ts";

const text: Dict<{ signOut: string; pending: string; failure: string }> = {
  vi: { signOut: "Đăng xuất", pending: "Đang đăng xuất…", failure: "Không đăng xuất được. Thử lại." },
  en: { signOut: "Sign out", pending: "Signing out…", failure: "Could not sign out. Try again." },
};
export function OnboardingSignOut() {
  const t = useT(text);
  const signOut = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.signOut();
      if (error) throw error;
    },
    onSuccess: () => window.location.assign("/login"),
  });
  return (
    <div>
      {signOut.isError && <Alert variant="destructive">{t.failure}</Alert>}
      <Button variant="ghost" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
        {signOut.isPending ? t.pending : t.signOut}
      </Button>
    </div>
  );
}
