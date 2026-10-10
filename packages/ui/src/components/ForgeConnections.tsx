// This machine's GitLab and GitHub tokens in one place (GROUP-repos-forge). They used to sit inside the "GitLab merge
// request" card, so someone linking a group to a system had no idea where to put one. Linking, init, fetch, pull and
// MRs all read them from here.
import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { DesktopSettings, ForgeUse, GitLabCheck } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@xdev-hive/ui/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@xdev-hive/ui/components/ui/collapsible";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { Badge, ErrorNote, Notice } from "#ui/components/common.tsx";
import { formatTime, hashParam, useAction, useHive } from "#ui/hooks.ts";
import { useT, type MessageKey } from "#ui/i18n/index.tsx";

/** Where the card is, opened and scrolled to: Cài đặt máy connected to a hub, the Projects page of a local app. */
export const forgeSettingsHref = (mode: string | undefined) => `#/${mode === "hub" ? "settings" : "projects"}?fold=forges`;

const FORM_GRID = "grid items-center gap-3 sm:grid-cols-[180px_1fr]";

export function forgeConnected(settings: DesktopSettings): boolean {
  return Boolean((settings.gitlab.url && settings.gitlab.hasToken) || settings.github.hasToken);
}

export function ForgeUseLine({ use }: { use: ForgeUse | null | undefined }) {
  const t = useT();
  if (!use) return <span className="text-xs text-muted-foreground">{t("forges.neverUsed")}</span>;
  const vars = { at: formatTime(use.at), by: t(`forges.by.${use.by}` as MessageKey), user: use.user ?? "" };
  return <span className="text-xs text-muted-foreground" data-forge-used>{t(use.user ? "forges.lastUsedUser" : "forges.lastUsed", vars)}</span>;
}

function ForgeForm({ kind, settings, onSaved }: { kind: "gitlab" | "github"; settings: DesktopSettings; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const g = settings[kind];
  const [url, setUrl] = useState(g.url);
  const [token, setToken] = useState("");
  const [check, setCheck] = useState<GitLabCheck | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const on = kind === "gitlab" ? Boolean(g.url && g.hasToken) : g.hasToken;
  const name = kind === "gitlab" ? "GitLab" : "GitHub";
  const id = kind === "gitlab" ? "gl" : "gh";
  return (
    <section className="flex flex-col gap-3" data-forge={kind}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-fg-strong">{name}</span>
        <Badge tone={on ? "ok" : "warn"}>{t(on ? "forges.connected" : "forges.notSet")}</Badge>
        {on ? <ForgeUseLine use={g.use} /> : null}
      </div>
      {kind === "github" ? <p className="m-0 text-xs break-words text-muted-foreground">{t("forges.githubScopes")}</p> : null}
      <div className={FORM_GRID}>
        <Label htmlFor={`${id}-url`}>{t(kind === "gitlab" ? "projects.gitlabUrl" : "projects.githubUrl")}</Label>
        <Input id={`${id}-url`} className="font-mono" placeholder={kind === "gitlab" ? "https://gitlab.example.com" : "https://github.com"} value={url} onChange={(e) => (setSaved(false), setUrl(e.target.value))} />
        <Label htmlFor={`${id}-token`}>Access token</Label>
        <Input
          id={`${id}-token`}
          className="font-mono"
          type="password"
          autoComplete="off"
          placeholder={g.hasToken ? t("projects.savedKeep") : t(kind === "gitlab" ? "forges.gitlabTokenHint" : "forges.githubTokenHint")}
          value={token}
          onChange={(e) => (setSaved(false), setToken(e.target.value))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-forge-save={kind}
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await client.desktop!.updateSettings({ [kind]: { url, token } });
              setToken("");
              setCheck(null);
              setSaved(true);
              onSaved();
            })
          }
        >
          {t("projects.save")}
        </Button>
        <Button
          variant="outline"
          data-forge-check={kind}
          disabled={action.busy || !g.hasToken}
          onClick={() =>
            void action.run(async () => {
              setCheck(await (kind === "gitlab" ? client.desktop!.checkGitLab() : client.desktop!.checkGitHub()));
              // The check is a use: the line above shows it and the account it answered with.
              onSaved();
            })
          }
        >
          {t("projects.checkConnection")}
        </Button>
        {saved ? <span className="text-sm text-success">{t("agents.saved")}</span> : null}
      </div>
      {check ? (
        <Notice tone={check.ok ? "ok" : "error"} className="whitespace-pre-wrap" data-forge-result={kind}>
          {check.message}
        </Notice>
      ) : null}
      <ErrorNote error={action.error} />
    </section>
  );
}

/** Opened by itself when nothing is connected yet, or when a link came here for it. */
export function ForgeCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const t = useT();
  const asked = hashParam("fold") === "forges";
  const [open, setOpen] = useState(asked || !forgeConnected(settings));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (asked) ref.current?.scrollIntoView({ block: "start" });
  }, [asked]);
  return (
    <Card ref={ref} id="forge-connections" data-forge-card>
      <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-3">
        <CardHeader>
          <CollapsibleTrigger
            data-fold="forges"
            className="group flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            <span className="min-w-0 flex-1 type-heading-sm text-fg-strong">{t("forges.title")}</span>
            <Badge tone={forgeConnected(settings) ? "ok" : "warn"}>{t(forgeConnected(settings) ? "projects.configured" : "projects.notConfigured")}</Badge>
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-6">
            <CardDescription className="break-words">{t("forges.hint")}</CardDescription>
            <ForgeForm kind="gitlab" settings={settings} onSaved={onSaved} />
            <ForgeForm kind="github" settings={settings} onSaved={onSaved} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/** Said where the tokens are missing (Service & công cụ, a group's panel), with the way to the card. */
export function ForgeMissing({ className }: { className?: string }) {
  const t = useT();
  const { me } = useHive();
  return (
    <Notice tone="warn" className={className} data-forge-missing>
      {t("forges.missing")}{" "}
      <a className="font-medium text-primary underline underline-offset-2" href={forgeSettingsHref(me?.mode)} data-forge-link>
        {t("forges.openSettings")}
      </a>
    </Notice>
  );
}

/** The errors that mean "no token on this machine": the panel that got one shows the way to the card under it. */
export const isForgeTokenError = (key: unknown) => key === "errors.gitlabNoToken" || key === "errors.githubNoToken";
