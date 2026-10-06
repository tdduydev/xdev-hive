import { useState } from "react";
import { KeyRound, Link2, LogOut } from "lucide-react";
import { cn } from "cn";
import type { Me } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@xdev-hive/ui/components/ui/dropdown-menu";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import type { HiveClient } from "#ui/client.ts";
import { useAction } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useSystemTheme } from "#ui/lib/theme.ts";
import { XMark } from "./Brand.tsx";
import { Badge, ErrorNote, Notice, STATUS_TONE } from "./common.tsx";
import { LanguageMenu, ThemeMenu } from "./Language.tsx";
import { GrantBadge } from "#ui/components/GrantEditor.tsx";

export const MIN_PASSWORD = 10;

/** Current + new password (twice). The hub checks the rules again. */
export function PasswordForm({ onSubmit, submitLabel }: { onSubmit: (current: string, next: string) => Promise<unknown>; submitLabel: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const action = useAction();
  const t = useT();
  const problem =
    next && next.length < MIN_PASSWORD
      ? t("password.tooShort", { min: MIN_PASSWORD })
      : again && next !== again
        ? t("password.mismatch")
        : null;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || !current || !next || next !== again) return;
        void action.run(() => onSubmit(current, next));
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="pw-current">{t("password.current")}</Label>
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pw-next">{t("password.next")}</Label>
        <Input id="pw-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pw-again">{t("password.again")}</Label>
        <Input id="pw-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">{t("password.rules", { min: MIN_PASSWORD })}</p>
      <ErrorNote error={problem ?? action.error} />
      <Button type="submit" disabled={Boolean(problem) || !current || !next || next !== again || action.busy}>
        {action.busy ? t("password.saving") : submitLabel}
      </Button>
    </form>
  );
}

/** First sign-in with a temporary password: nothing else is reachable until it is changed. */
export function ChangePasswordScreen({ client, me, onDone, onSignOut }: { client: HiveClient; me: Me; onDone: () => void; onSignOut?: () => void }) {
  useSystemTheme();
  const t = useT();
  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <XMark size={26} />
            {t("password.firstTitle")}
          </CardTitle>
          <CardDescription>
            {t("password.firstBody", { name: me.user?.displayName ?? me.name })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <PasswordForm
            submitLabel={t("password.firstSubmit")}
            onSubmit={async (current, next) => {
              await client.account!.changePassword(current, next);
              onDone();
            }}
          />
          {onSignOut ? (
            <Button variant="ghost" size="sm" onClick={onSignOut}>
              {t("account.signOut")}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/** Initials for the round avatar: first letters of the first two words ("Trần Đức" → TĐ). */
export const initials = (name: string) =>
  name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

/**
 * Sidebar footer: who is signed in, what they may see, language, appearance, change password, sign out.
 * `subtitle` replaces the "@user · role" line (the desktop shows the machine and app version there). `onNavigate`:
 * an entry opened a page, so a phone's menu drawer closes as a menu link would.
 */
export function AccountMenu({
  client,
  me,
  onSignOut,
  subtitle,
  onNavigate,
}: {
  client: HiveClient;
  me: Me;
  onSignOut?: () => void;
  subtitle?: string;
  onNavigate?: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  const t = useT();
  const grants = Object.entries(me.access?.projects ?? {});
  const where = me.mode === "hub" ? t("account.hub") : t("account.local");
  const role = t(`role.${me.role}`);
  const name = me.user?.displayName ?? me.name;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("shell.account")}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm p-1 text-left outline-none hover:bg-hover focus-visible:focus-ring data-[state=open]:bg-hover"
          >
            <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-primary text-[10px]/none font-semibold text-primary-foreground">
              {initials(name)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-xs/4 font-semibold text-fg-strong">{me.user?.username ?? name}</span>
              <span className={cn("truncate text-[11px]/[14px] text-fg-muted", subtitle && "font-mono")}>
                {subtitle ?? `${me.user ? `@${me.user.username}` : where} · ${role}`}
              </span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64">
          <DropdownMenuLabel className="flex flex-col gap-1.5 pt-2 type-body-sm tracking-normal normal-case">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-semibold text-fg-strong normal-case tracking-normal">{name}</span>
              <Badge tone={STATUS_TONE[me.role]}>{role}</Badge>
            </span>
            <span className="text-xs text-muted-foreground">{where}</span>
            {me.access ? (
              <span className="flex flex-wrap gap-1 pt-1">
                {grants.length ? (
                  grants.map(([p, g]) => <GrantBadge key={p} grant={g} label={p} />)
                ) : (
                  <span className="text-xs text-muted-foreground">{t("account.noGrants")}</span>
                )}
              </span>
            ) : me.mode === "hub" && me.role === "admin" ? (
              <span className="text-xs text-muted-foreground">{t("account.adminAll")}</span>
            ) : null}
            {me.sso?.linked ? <span className="text-xs text-muted-foreground">{t("account.ssoLinked", { name: me.sso.name })}</span> : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <LanguageMenu />
          <ThemeMenu />
          {client.account && me.sso && !me.sso.linked ? (
            <DropdownMenuItem
              onSelect={() => void client.account!.linkSso().then(({ url }) => window.location.assign(url), () => undefined)}
            >
              <Link2 />
              {t("account.linkSso", { name: me.sso.name })}
            </DropdownMenuItem>
          ) : null}
          {/* Token is one's own (machines, CI), so it sits with the account, not in the menu (roadmap 49b). */}
          {client.tokens && (me.user || (me.mode === "hub" && me.role === "admin" && !me.access)) ? (
            <DropdownMenuItem asChild onSelect={onNavigate}>
              <a href="#/tokens" data-account-tokens>
                <KeyRound />
                {t("account.tokens")}
              </a>
            </DropdownMenuItem>
          ) : null}
          {client.account ? (
            <DropdownMenuItem onSelect={() => setChanging(true)}>
              <KeyRound />
              {t("password.change")}
            </DropdownMenuItem>
          ) : null}
          {onSignOut ? (
            <DropdownMenuItem onSelect={onSignOut}>
              <LogOut />
              {t("account.signOut")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={changing}
        onOpenChange={(open) => {
          setChanging(open);
          if (!open) setChanged(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("password.change")}</DialogTitle>
            <DialogDescription>{t("password.changeFor", { username: me.user?.username ?? "" })}</DialogDescription>
          </DialogHeader>
          {changed ? (
            <Notice tone="ok" title={t("password.changed")} />
          ) : (
            <PasswordForm
              submitLabel={t("password.change")}
              onSubmit={async (current, next) => {
                await client.account!.changePassword(current, next);
                setChanged(true);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
