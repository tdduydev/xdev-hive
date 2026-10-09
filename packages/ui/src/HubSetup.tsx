import { useState, type ReactNode } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { hubSetupState, saveHubSetup } from "./client.ts";
import { MIN_PASSWORD } from "./components/Account.tsx";
import { HiveWordmark } from "./components/Brand.tsx";
import { ErrorNote } from "./components/common.tsx";
import { LanguageSelect } from "./components/Language.tsx";
import { errorMessage } from "./hooks.ts";
import { useT, type MessageKey } from "./i18n/index.tsx";
import { useSystemTheme } from "./lib/theme.ts";

const SEAWEED = "http://seaweedfs:8888";

/**
 * The first page of a hub started by `docker compose up` alone (roadmap 75): the admin account and the hub's settings,
 * saved once; the hub restarts with them and this page gives way to the sign-in.
 */
export function HubSetup({ locked, defaults, onDone }: { locked: string[]; defaults: Record<string, string>; onDone: () => void }) {
  useSystemTheme();
  const t = useT();
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  // The LAN name this browser used is the most likely one the machines use too.
  const [values, setValues] = useState<Record<string, string>>(() => ({
    ...defaults,
    HIVE_LAN_HOSTS: defaults.HIVE_LAN_HOSTS ?? (window.location.hostname === "localhost" ? "" : window.location.hostname),
  }));
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const isLocked = (key: string) => locked.includes(key);
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));
  const mismatch = again.length > 0 && again !== password;
  const ready = code.trim() && username.trim() && password.length >= MIN_PASSWORD && password === again;

  const text = (key: string, label: MessageKey, opts: { hint?: MessageKey; placeholder?: string; secret?: boolean } = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`setup-${key}`}>{t(label)}</Label>
      <Input
        id={`setup-${key}`}
        className="font-mono"
        type={opts.secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        disabled={isLocked(key)}
        placeholder={isLocked(key) ? t("hubSetup.locked") : opts.placeholder}
        value={isLocked(key) && opts.secret ? "" : (values[key] ?? "")}
        onChange={(e) => set(key, e.target.value)}
      />
      {opts.hint ? <p className="text-xs text-muted-foreground">{t(opts.hint)}</p> : null}
    </div>
  );
  const check = (key: string, label: MessageKey, on: string, off: string) => (
    <div className="flex items-center gap-2">
      <Checkbox id={`setup-${key}`} disabled={isLocked(key)} checked={(values[key] ?? off) === on} onCheckedChange={(v) => set(key, v === true ? on : off)} />
      <Label htmlFor={`setup-${key}`} className="font-normal">
        {t(label)}
        {isLocked(key) ? <span className="ml-1 text-xs text-muted-foreground">({t("hubSetup.locked")})</span> : null}
      </Label>
    </div>
  );
  const section = (title: MessageKey, children: ReactNode, hint?: MessageKey) => (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-semibold">{t(title)}</legend>
      {hint ? <p className="text-xs text-muted-foreground">{t(hint)}</p> : null}
      {children}
    </fieldset>
  );

  if (restarting) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>
              <HiveWordmark height={44} />
            </CardTitle>
            <CardDescription role="status">{t("hubSetup.restarting")}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh justify-center bg-muted/40 px-4 py-8">
      <Card className="w-full max-w-2xl">
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready || busy) return;
            setBusy(true);
            setFailure(null);
            // Only what the environment does not hold: the hub drops locked keys anyway.
            const sent = Object.fromEntries(Object.entries(values).filter(([k]) => !isLocked(k)));
            saveHubSetup({ code: code.trim(), admin: { username: username.trim(), password }, values: sent })
              .then(() => {
                setRestarting(true);
                // The hub exits and Docker starts it again: back once it answers as set up.
                const poll = () =>
                  hubSetupState().then(
                    (s) => (s.pending ? setTimeout(poll, 1500) : onDone()),
                    () => setTimeout(poll, 1500),
                  );
                setTimeout(poll, 1500);
              })
              .catch((err: unknown) => setFailure(errorMessage(err)))
              .finally(() => setBusy(false));
          }}
        >
          <CardHeader>
            <CardTitle className="flex flex-col gap-3">
              <HiveWordmark height={44} />
              <span>{t("hubSetup.title")}</span>
            </CardTitle>
            <CardDescription>{t("hubSetup.intro")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-code">{t("hubSetup.code")}</Label>
              <Input id="setup-code" className="font-mono uppercase" autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
              <p className="text-xs text-muted-foreground">
                {t("hubSetup.codeHint")}
              </p>
            </div>
            {section(
              "hubSetup.admin",
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="setup-username">{t("hubSetup.username")}</Label>
                  <Input id="setup-username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="setup-password">{t("hubSetup.password")}</Label>
                    <Input id="setup-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="setup-password-again">{t("hubSetup.passwordAgain")}</Label>
                    <Input id="setup-password-again" type="password" autoComplete="new-password" aria-invalid={mismatch} value={again} onChange={(e) => setAgain(e.target.value)} />
                  </div>
                </div>
                <p className={mismatch ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {mismatch ? t("hubSetup.mismatch") : t("hubSetup.passwordRules", { min: MIN_PASSWORD })}
                </p>
              </>,
            )}
            {section(
              "hubSetup.address",
              <>
                {text("HIVE_ALLOWED_HOSTS", "hubSetup.allowedHosts", { hint: "hubSetup.allowedHostsHint", placeholder: "hive.example.com" })}
                {text("HIVE_LAN_HOSTS", "hubSetup.lanHosts", { hint: "hubSetup.lanHostsHint", placeholder: "10.0.0.5,my-server" })}
                {text("HIVE_PUBLIC_URL", "hubSetup.publicUrl", { hint: "hubSetup.publicUrlHint", placeholder: "https://hive.example.com" })}
                {check("HIVE_TRUST_PROXY", "hubSetup.trustProxy", "1", "")}
              </>,
            )}
            {section("hubSetup.files", check("HIVE_SEAWEEDFS_URL", "hubSetup.seaweed", values.HIVE_SEAWEEDFS_URL || SEAWEED, ""))}
            {section(
              "hubSetup.embed",
              <>
                {text("HIVE_EMBED_URL", "hubSetup.embedUrl", { hint: "hubSetup.embedUrlHint", placeholder: "http://ollama:11434/v1" })}
                <div className="grid gap-3 sm:grid-cols-2">
                  {text("HIVE_EMBED_MODEL", "hubSetup.embedModel", { placeholder: "bge-m3" })}
                  {text("HIVE_EMBED_KEY", "hubSetup.embedKey", { secret: true })}
                </div>
              </>,
            )}
            {section(
              "hubSetup.sso",
              <div className="grid gap-3 sm:grid-cols-2">
                {text("HIVE_OIDC_ISSUER", "hubSetup.oidcIssuer", { placeholder: "https://gitlab.example.com" })}
                {text("HIVE_OIDC_NAME", "hubSetup.oidcName", { placeholder: "GitLab" })}
                {text("HIVE_OIDC_CLIENT_ID", "hubSetup.oidcClientId")}
                {text("HIVE_OIDC_CLIENT_SECRET", "hubSetup.oidcClientSecret", { secret: true })}
              </div>,
              "hubSetup.ssoHint",
            )}
            {section(
              "hubSetup.options",
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {text("HIVE_BACKUP_HOURS", "hubSetup.backupHours")}
                  {text("HIVE_BACKUP_KEEP", "hubSetup.backupKeep")}
                </div>
                {check("HIVE_MEMORY_APPROVAL", "hubSetup.memoryApproval", "on", "off")}
                {check("HIVE_REMOTE_TERMINAL", "hubSetup.remoteTerminal", "1", "")}
                {check("HIVE_GATE_JOBS", "hubSetup.gateJobs", "1", "")}
              </>,
            )}
            {section(
              "hubSetup.https",
              <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                {"HIVE_HOSTNAME=hive.example.com docker compose --profile https up -d\nTUNNEL_TOKEN=… docker compose --profile tunnel up -d"}
              </pre>,
              "hubSetup.httpsHint",
            )}
            <ErrorNote error={failure} />
          </CardContent>
          <CardFooter className="flex flex-col items-stretch gap-3">
            <Button id="setup-save" type="submit" disabled={!ready || busy}>
              {busy ? t("hubSetup.saving") : t("hubSetup.save")}
            </Button>
            <LanguageSelect />
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
