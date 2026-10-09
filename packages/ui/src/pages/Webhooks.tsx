// Admin → Webhooks: chat webhooks (Teams Workflows, Slack) for hub events. The hub keeps the URLs;
// the page only ever sees a hint of them.
import { useState } from "react";
import { WEBHOOK_EVENTS, WEBHOOK_KINDS, type WebhookEvent, type WebhookInfo, type WebhookInput } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Empty, ErrorNote, Notice } from "#ui/components/common.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { LOCALES, useT } from "#ui/i18n/index.tsx";
import { AdminStats, AdminTable, type AdminRow } from "./admin/cosmic.tsx";

const EMPTY: WebhookInput = { name: "", kind: "teams", url: "", events: [...WEBHOOK_EVENTS], projects: [], locale: "vi", enabled: true };
const HINT = "text-xs text-muted-foreground";

export function WebhooksTab() {
  const { client } = useHive();
  const t = useT();
  const hooks = client.webhooks!;
  const list = useQuery(() => hooks.list(), [hooks]);
  const action = useAction();
  const [editing, setEditing] = useState<WebhookInput | null>(null);
  // The last test of each webhook, shown under the table: a row has no room for the hub's error text.
  const [tested, setTested] = useState<Record<number, { ok: boolean; error: string | null }>>({});
  const items = list.data ?? [];
  const rows: AdminRow[] = items.map((w) => ({
    key: String(w.id),
    cells: [
      { text: w.name, sub: w.urlHint, strong: true, tone: !w.enabled ? "neutral" : w.lastError ? "bad" : "ok", title: w.name },
      { text: w.enabled ? t(`webhooks.kind.${w.kind}`) : `${t(`webhooks.kind.${w.kind}`)} · ${t("webhooks.off")}` },
      {
        text: w.events.map((e) => t(`webhooks.event.${e}`)).join(", "),
        sub: `${w.projects.length ? t("webhooks.onlyProjects", { projects: w.projects.join(", ") }) : t("webhooks.allProjects")} · ${LOCALES[w.locale as keyof typeof LOCALES]?.name ?? w.locale}`,
        title: w.events.map((e) => t(`webhooks.event.${e}`)).join(", "),
      },
      {
        text: w.lastSentAt ? formatTime(w.lastSentAt) : "—",
        sub: w.lastSentAt ? (w.lastError ? t("adminOps.webhooks.failed", { error: w.lastError }) : t("adminOps.webhooks.sent")) : undefined,
        title: w.lastError ?? undefined,
      },
    ],
    action: {
      label: t("webhooks.test"),
      disabled: action.busy,
      onClick: () =>
        void action.run(async () => {
          const result = await hooks.test(w.id);
          setTested((c) => ({ ...c, [w.id]: result }));
          list.reload();
        }),
    },
    extra: (
      <>
        <Button size="sm" variant="ghost" onClick={() => setEditing({ id: w.id, name: w.name, kind: w.kind, url: "", events: w.events, projects: w.projects, locale: w.locale, enabled: w.enabled })}>
          {t("webhooks.edit")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={action.busy}
          onClick={() => {
            if (window.confirm(t("webhooks.confirmRemove", { name: w.name }))) void action.run(async () => (await hooks.remove(w.id), list.reload()));
          }}
        >
          {t("webhooks.remove")}
        </Button>
      </>
    ),
  }));
  return (
    <div className="cx-ops-stack">
      <AdminStats
        stats={[
          { key: "all", label: t("adminOps.webhooks.count"), value: items.length, tone: "info" },
          { key: "on", label: t("adminOps.webhooks.enabled"), value: items.filter((w) => w.enabled).length, tone: "ok" },
          { key: "bad", label: t("adminOps.webhooks.failing"), value: items.filter((w) => w.enabled && w.lastError).length, note: t("adminOps.webhooks.failingNote"), tone: items.some((w) => w.enabled && w.lastError) ? "bad" : "ok" },
        ]}
      />
      <div className="cx-ops-toolbar !mb-0">
        <p className="cx-ops-hint m-0 min-w-0 flex-1">{t("webhooks.intro")}</p>
        {!editing ? (
          <Button size="sm" variant="glass" onClick={() => setEditing(EMPTY)}>
            {t("webhooks.add")}
          </Button>
        ) : null}
      </div>
      <ErrorNote error={list.error ?? action.error} />
      {editing ? (
        <WebhookForm
          initial={editing}
          onDone={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}
      {list.data?.length === 0 && !editing ? <Empty>{t("webhooks.none")}</Empty> : null}
      {rows.length ? (
        <AdminTable cols={[t("webhooks.name"), t("webhooks.kindLabel"), t("webhooks.events"), t("adminOps.webhooks.last")]} grid="minmax(220px,1.2fr) 140px minmax(220px,1.6fr) minmax(150px,1fr)" minWidth={1040} rows={rows} />
      ) : null}
      {items.map((w) => {
        const r = tested[w.id];
        return r ? <Notice key={w.id} tone={r.ok ? "ok" : "error"} title={`${w.name}: ${r.ok ? t("webhooks.testOk") : t("webhooks.testFailed", { error: r.error ?? "?" })}`} /> : null;
      })}
    </div>
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
    <div className="cx-ops-panel">
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
            <Button type="submit" variant="solid" size="sm" disabled={action.busy}>
              {t("webhooks.save")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onDone}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
    </div>
  );
}
