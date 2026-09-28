// Admin → Webhooks: chat webhooks (Teams Workflows, Slack) for hub events. The hub keeps the URLs;
// the page only ever sees a hint of them.
import { useState } from "react";
import { WEBHOOK_EVENTS, WEBHOOK_KINDS, type WebhookEvent, type WebhookInfo, type WebhookInput } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Badge, Empty, ErrorNote, Notice } from "../components/common.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "../hooks.ts";
import { LOCALES, useT } from "../i18n/index.tsx";

const EMPTY: WebhookInput = { name: "", kind: "teams", url: "", events: [...WEBHOOK_EVENTS], projects: [], locale: "vi", enabled: true };
const HINT = "text-xs text-muted-foreground";

export function WebhooksTab() {
  const { client } = useHive();
  const t = useT();
  const hooks = client.webhooks!;
  const list = useQuery(() => hooks.list(), [hooks]);
  const [editing, setEditing] = useState<WebhookInput | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("webhooks.intro")}</p>
      <ErrorNote error={list.error} />
      {editing ? (
        <WebhookForm
          initial={editing}
          onDone={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : (
        <div>
          <Button onClick={() => setEditing(EMPTY)}>{t("webhooks.add")}</Button>
        </div>
      )}
      {list.data?.length === 0 && !editing ? <Empty>{t("webhooks.none")}</Empty> : null}
      {list.data?.map((w) => (
        <WebhookCard
          key={w.id}
          webhook={w}
          onEdit={() => setEditing({ id: w.id, name: w.name, kind: w.kind, url: "", events: w.events, projects: w.projects, locale: w.locale, enabled: w.enabled })}
          onChanged={list.reload}
        />
      ))}
    </div>
  );
}

function WebhookCard({ webhook: w, onEdit, onChanged }: { webhook: WebhookInfo; onEdit: () => void; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [tested, setTested] = useState<{ ok: boolean; error: string | null } | null>(null);
  const hooks = client.webhooks!;
  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-2 px-4">
        <div className="flex flex-wrap items-center gap-2">
          <b className="min-w-0 break-words">{w.name}</b>
          <Badge tone="accent">{t(`webhooks.kind.${w.kind}`)}</Badge>
          {!w.enabled ? <Badge tone="neutral">{t("webhooks.off")}</Badge> : null}
          <code className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">{w.urlHint}</code>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {w.events.map((e) => (
            <Badge key={e}>{t(`webhooks.event.${e}`)}</Badge>
          ))}
        </div>
        <div className={HINT}>
          {w.projects.length ? t("webhooks.onlyProjects", { projects: w.projects.join(", ") }) : t("webhooks.allProjects")} · {LOCALES[w.locale as keyof typeof LOCALES]?.name ?? w.locale}
          {w.lastSentAt ? ` · ${w.lastError ? t("webhooks.lastFailed", { time: formatTime(w.lastSentAt), error: w.lastError }) : t("webhooks.lastSent", { time: formatTime(w.lastSentAt) })}` : ""}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void action.run(async () => (setTested(await hooks.test(w.id)), onChanged()))}>
            {t("webhooks.test")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {t("webhooks.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={action.busy}
            onClick={() => {
              if (window.confirm(t("webhooks.confirmRemove", { name: w.name }))) void action.run(async () => (await hooks.remove(w.id), onChanged()));
            }}
          >
            {t("webhooks.remove")}
          </Button>
        </div>
        {tested ? <Notice tone={tested.ok ? "ok" : "error"} title={tested.ok ? t("webhooks.testOk") : t("webhooks.testFailed", { error: tested.error ?? "?" })} /> : null}
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}

function WebhookForm({ initial, onDone }: { initial: WebhookInput; onDone: () => void }) {
  const { client } = useHive();
  const t = useT();
  const projects = useProjects();
  const action = useAction();
  const [w, setW] = useState<WebhookInput>(initial);
  const toggle = (e: WebhookEvent, on: boolean) => setW({ ...w, events: on ? [...w.events, e] : w.events.filter((x) => x !== e) });
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(ev) => {
            ev.preventDefault();
            void action.run(async () => (await client.webhooks!.save({ ...w, url: w.url?.trim() || undefined }), onDone()));
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[160px_1fr] sm:items-center">
            <Label htmlFor="wh-name">{t("webhooks.name")}</Label>
            <Input id="wh-name" value={w.name} placeholder={t("webhooks.namePlaceholder")} onChange={(e) => setW({ ...w, name: e.target.value })} />
            <Label htmlFor="wh-kind">{t("webhooks.kindLabel")}</Label>
            <NativeSelect id="wh-kind" value={w.kind} onChange={(e) => setW({ ...w, kind: e.target.value as WebhookInput["kind"] })}>
              {WEBHOOK_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`webhooks.kind.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Label htmlFor="wh-url">URL</Label>
            <div className="flex flex-col gap-1">
              <Input
                id="wh-url"
                type="password"
                autoComplete="off"
                value={w.url ?? ""}
                placeholder={initial.id === undefined ? "https://…" : t("webhooks.keepUrl")}
                onChange={(e) => setW({ ...w, url: e.target.value })}
              />
              <span className={HINT}>{t(w.kind === "teams" ? "webhooks.urlHintTeams" : "webhooks.urlHintSlack")}</span>
            </div>
            <Label>{t("webhooks.events")}</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WEBHOOK_EVENTS.map((e) => (
                <label key={e} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={w.events.includes(e)} onCheckedChange={(v) => toggle(e, v === true)} />
                  {t(`webhooks.event.${e}`)}
                </label>
              ))}
            </div>
            <Label htmlFor="wh-projects">{t("webhooks.projects")}</Label>
            <div className="flex flex-col gap-1">
              <Input
                id="wh-projects"
                className="font-mono"
                value={w.projects.join(", ")}
                placeholder={projects.slice(0, 3).join(", ") || "app"}
                onChange={(e) => setW({ ...w, projects: e.target.value.split(/[\s,]+/).filter(Boolean) })}
              />
              <span className={HINT}>{t("webhooks.projectsHint")}</span>
            </div>
            <Label htmlFor="wh-locale">{t("webhooks.locale")}</Label>
            <NativeSelect id="wh-locale" value={w.locale} onChange={(e) => setW({ ...w, locale: e.target.value })}>
              {Object.entries(LOCALES).map(([id, l]) => (
                <NativeSelectOption key={id} value={id}>
                  {l.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={w.enabled} onCheckedChange={(v) => setW({ ...w, enabled: v === true })} />
            {t("webhooks.enabled")}
          </label>
          <ErrorNote error={action.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={action.busy}>
              {t("webhooks.save")}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
