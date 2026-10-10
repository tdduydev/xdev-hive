import { useEffect, useState } from "react";
import type { HubRole } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { HiveWordmark } from "./components/Brand.tsx";
import { ErrorNote } from "./components/common.tsx";
import { LanguageSelect } from "./components/Language.tsx";
import { acceptInvite, peekInvite } from "./client.ts";
import { errorMessage } from "./hooks.ts";
import { useT } from "./i18n/index.tsx";
import { useSystemTheme } from "./lib/theme.ts";

/** The token of a sign-up link (`#/invite/<token>`), or null when the page is not one. */
export const inviteTokenFromHash = (hash: string): string | null => /^#\/invite\/([\w-]+)$/.exec(hash)?.[1] ?? null;

/** Sign-up by link: shows what the link gives, asks for a username and password (just the password for an invited account). */
export function InviteAccept({ token, onDone, onBack }: { token: string; onDone: () => void; onBack: () => void }) {
  useSystemTheme();
  const t = useT();
  const [invite, setInvite] = useState<{ role: HubRole; username: string | null } | null>(null);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    peekInvite(token).then(
      (i) => alive && setInvite(i),
      (err: unknown) => alive && setFailure(errorMessage(err)),
    );
    return () => {
      alive = false;
    };
  }, [token]);

  const ready = Boolean(invite && password && (invite.username || username.trim()));
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4" data-invite-page>
      <Card className="w-full max-w-sm">
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || busy) return;
            setBusy(true);
            setFailure(null);
            acceptInvite({ token, password, ...(invite?.username ? {} : { username: username.trim(), displayName: displayName.trim() || undefined }) })
              .then(onDone, (err: unknown) => setFailure(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          <CardHeader>
            <CardTitle>
              <HiveWordmark height={44} />
            </CardTitle>
            <CardDescription>
              {invite ? (invite.username ? t("invite.forAccount", { username: invite.username }) : t("invite.hint", { role: t(`adminUsers.hubRole.${invite.role}`) })) : failure ? t("invite.title") : t("invite.checking")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {invite && !invite.username ? (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="invite-username">{t("login.username")}</Label>
                  <Input id="invite-username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoFocus />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="invite-name">{t("invite.displayName")}</Label>
                  <Input id="invite-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </div>
              </>
            ) : null}
            {invite ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="invite-password">{t("login.password")}</Label>
                <Input id="invite-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            ) : null}
            <ErrorNote error={failure} />
          </CardContent>
          <CardFooter className="flex flex-col items-stretch gap-3">
            {invite ? (
              <Button type="submit" disabled={!ready || busy}>
                {busy ? t("invite.submitting") : t("invite.submit")}
              </Button>
            ) : null}
            <Button type="button" variant="link" size="sm" className="h-auto self-center p-0 text-xs text-muted-foreground" onClick={onBack}>
              {t("invite.backToLogin")}
            </Button>
            <LanguageSelect />
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
