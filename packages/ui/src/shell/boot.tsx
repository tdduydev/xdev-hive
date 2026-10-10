// What both shells need before they draw anything: the hub's answer to "who am I", an error screen when there is
// none, and the forced password change. WebApp, DesktopApp and the temporary LocalApp start from here.
import { useEffect, type ReactNode } from "react";
import type { Me } from "@xdev-hive/core";
import { Button } from "#ui/components/ui/button.tsx";
import type { HiveClient } from "#ui/client.ts";
import { ChangePasswordScreen } from "#ui/components/Account.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { CrashCard, ErrorBoundary } from "#ui/components/ErrorBoundary.tsx";
import { useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useSystemTheme } from "#ui/lib/theme.ts";

/** Full-window message (connecting, or a failed sign-in). */
export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-sm text-muted-foreground">{children}</div>;
}

export function AppBoot({ client, onSignOut, children }: { client: HiveClient; onSignOut?: () => void; children: (me: Me) => ReactNode }) {
  // The last resort, for an error in the frame itself: a page's own is caught closer, with the frame kept.
  return (
    <ErrorBoundary
      onError={(text) => void client.desktop?.logError?.(text).catch(() => undefined)}
      fallback={(error, retry) => <CrashCard error={error} retry={retry} whole />}
    >
      <Booted client={client} onSignOut={onSignOut}>{children}</Booted>
    </ErrorBoundary>
  );
}

function Booted({ client, onSignOut, children }: { client: HiveClient; onSignOut?: () => void; children: (me: Me) => ReactNode }) {
  useSystemTheme();
  const t = useT();
  const me = useQuery(() => client.me(), [client]);
  useEffect(() => {
    const changed = () => me.reload();
    window.addEventListener("xdev-hive:connection-changed", changed);
    return () => window.removeEventListener("xdev-hive:connection-changed", changed);
  }, [me.reload]);
  if (me.error) {
    return (
      <Centered>
        <ErrorNote error={me.error} />
        {onSignOut ? (
          <Button variant="outline" onClick={onSignOut}>
            {t("app.signInAgain")}
          </Button>
        ) : null}
      </Centered>
    );
  }
  if (!me.data) return <Centered>{t("app.connecting")}</Centered>;
  if (me.data.user?.mustChangePassword && client.account) {
    return <ChangePasswordScreen client={client} me={me.data} onSignOut={onSignOut} onDone={me.reload} />;
  }
  return <>{children(me.data)}</>;
}
