import { useState } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { ErrorNote, HiveLogo } from "./components/common.tsx";
import { LanguageSelect } from "./components/Language.tsx";
import { errorMessage } from "./hooks.ts";
import { useT } from "./i18n/index.tsx";
import { useSystemTheme } from "./lib/theme.ts";

/** Hub sign-in: username + password for people; an API token still works (CI, recovery). */
export function Login({
  onPassword,
  onToken,
  error,
}: {
  onPassword: (username: string, password: string) => Promise<void>;
  onToken: (token: string) => void;
  error?: string | null;
}) {
  useSystemTheme();
  const t = useT();
  const [useToken, setUseToken] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = useToken ? Boolean(token.trim()) : Boolean(username.trim() && password);

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || busy) return;
            if (useToken) {
              onToken(token.trim());
              return;
            }
            setBusy(true);
            setFailure(null);
            onPassword(username.trim(), password)
              .catch((err: unknown) => {
                setFailure(errorMessage(err));
                setPassword("");
              })
              .finally(() => setBusy(false));
          }}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <HiveLogo size={26} />
              xDev Hive
            </CardTitle>
            <CardDescription>{t("login.tagline")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {useToken ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="token">{t("login.token")}</Label>
                <Input
                  id="token"
                  className="font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder="hive_…"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoFocus
                />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="username">{t("login.username")}</Label>
                  <Input
                    id="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="password">{t("login.password")}</Label>
                  <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
              </>
            )}
            <ErrorNote error={failure ?? error} />
          </CardContent>
          <CardFooter className="flex flex-col items-stretch gap-3">
            <Button type="submit" disabled={!ready || busy}>
              {busy ? t("login.submitting") : t("login.submit")}
            </Button>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto self-center p-0 text-xs text-muted-foreground"
              onClick={() => {
                setUseToken(!useToken);
                setFailure(null);
              }}
            >
              {useToken ? t("login.useAccount") : t("login.useToken")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("login.help")}</p>
            <LanguageSelect />
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
