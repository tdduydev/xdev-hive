// Công cụ và dự án (docs/design/2026-09-redesign, xDev Hive Client): what the runner needs on this machine (the
// agent CLIs, the hive-mcp command) and in each repo, with the install the app can do, and admins' install requests.
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { FileText, FolderGit2, GitBranch, ListChecks, Plug, RefreshCw, Sparkles, SquareTerminal, Terminal, Wrench } from "lucide-react";
import { cn } from "cn";
import { requiredItemIds, type MachineCommand, type SetupItem, type SetupReport, type SetupState } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Empty, ErrorNote, Notice } from "#ui/components/common.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { formatTime, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";

const TONE: Record<SetupState, ChipKind> = { installed: "success", missing: "warning", outdated: "info", manual: "danger" };

/** The tile icon of a setup item, by what it is (cli:claude, shim, <project>:codegraph-index…). */
function iconOf(id: string): ComponentType<{ className?: string }> {
  if (id.startsWith("cli:")) return Terminal;
  if (id === "shim") return SquareTerminal;
  if (id.endsWith(":agents")) return FileText;
  if (id.endsWith(":codegraph-mcp")) return Plug;
  if (id.endsWith(":codegraph-index")) return GitBranch;
  if (id.endsWith(":superpowers")) return Sparkles;
  if (id.endsWith(":speckit")) return ListChecks;
  return Wrench;
}

export function SetupPage() {
  const { client } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const status = useQuery(() => desktop.setupStatus(), [desktop]);
  const info = useQuery(() => desktop.appInfo(), [desktop]);
  const settings = useQuery(() => desktop.settings(), [desktop]);
  const [report, setReport] = useState<SetupReport | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const checkedAt = useMemo(() => (status.data ? new Date().toISOString() : null), [status.data]);
  const requests = useQuery(() => desktop.hubRequests(), [desktop, tick]);
  const shown = report ?? status.data;
  const policy = requests.data?.policy ?? null;
  const required = policy && shown ? requiredItemIds(policy, shown.projects.map((p) => p.project)) : new Set<string>();
  const replace = (item: SetupItem) =>
    shown &&
    setReport({
      machine: shown.machine.map((i) => (i.id === item.id ? item : i)),
      projects: shown.projects.map((p) => ({ ...p, items: p.items.map((i) => (i.id === item.id ? item : i)) })),
    });
  const missing = shown ? [...shown.machine, ...shown.projects.flatMap((p) => p.items)].filter((i) => i.state !== "installed").length : 0;
  const platform = info.data?.platform;
  const os = platform === "darwin" || platform === "win32" || platform === "linux" ? t(`setup.platform.${platform}`) : (platform ?? "");

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-[18px] px-6 pt-5 pb-8">
      <h1 className="sr-only">{t("nav.setup")}</h1>
      <p className="sr-only">{t("setup.subtitle")}</p>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-xs/none text-fg-muted">{status.loading ? t("setup.checking") : checkedAt ? t("setup.lastChecked", { time: formatTime(checkedAt) }) : ""}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={status.loading}
          onClick={() => {
            setReport(null);
            status.reload();
          }}
        >
          <RefreshCw className={status.loading ? "animate-spin" : undefined} />
          {t("setup.recheck")}
        </Button>
      </div>
      <ErrorNote error={status.error} />
      {requests.data?.commands.length ? (
        <RequestsCard
          commands={requests.data.commands}
          onAnswered={() => {
            setTick((n) => n + 1);
            setReport(null);
            status.reload();
          }}
        />
      ) : null}
      {!shown && status.loading ? <p className="m-0 text-[13px] text-fg-muted">{t("setup.checkingAll")}</p> : null}
      {shown ? (
        <>
          <Notice tone={missing ? "warn" : "ok"}>
            {missing ? t("setup.notReady", { count: missing }) : t("setup.allReady")}
            {policy && required.size ? ` ${t("setup.policyRequires", { count: required.size })}` : ""}
          </Notice>
          <Group title={t("setup.tools")} sub={[settings.data?.machine, os].filter(Boolean).join(" · ")}>
            <SetupList items={shown.machine} required={required} onChanged={replace} />
          </Group>
          {shown.projects.length === 0 ? (
            <Empty>
              {rich(t("setup.noProjects"), {
                link: (
                  <a href="#/projects" className="font-medium text-fg-link underline underline-offset-2">
                    {t("nav.projects")}
                  </a>
                ),
              })}
            </Empty>
          ) : null}
          {shown.projects.map((p) => (
            <Group key={p.project} title={p.project} sub={p.repo} mono icon={FolderGit2}>
              <SetupList items={p.items} required={required} onChanged={replace} />
            </Group>
          ))}
        </>
      ) : null}
    </div>
  );
}

function Group({ title, sub, mono, icon: Icon, children }: { title: string; sub?: string; mono?: boolean; icon?: ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 flex flex-wrap items-center gap-2 text-[13px]/[18px] font-semibold text-fg-strong">
        {Icon ? <Icon className="size-3.5 text-fg-muted" /> : null}
        <span className={cn(mono && "font-mono")}>{title}</span>
        {sub ? <span className="min-w-0 font-mono text-xs/none font-normal break-all text-fg-muted">{sub}</span> : null}
      </h2>
      <div className="overflow-hidden rounded-[10px] border border-line-default bg-surface">{children}</div>
    </section>
  );
}

function RequestsCard({ commands, onAnswered }: { commands: MachineCommand[]; onAnswered: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [done, setDone] = useState<MachineCommand | null>(null);
  const answer = (c: MachineCommand, approve: boolean) =>
    void action.run(async () => {
      setDone(await client.desktop!.answerCommand(c.id, approve));
      onAnswered();
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("setup.requests")}</CardTitle>
        <CardDescription>{t("setup.requestsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          {commands.map((c) => (
            <div key={c.id} className="flex flex-col gap-2 rounded-md border border-line-default p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium break-words">{c.label}</span>
                <Button size="sm" variant="outline" disabled={action.busy} onClick={() => answer(c, true)}>
                  {action.busy ? t("setup.installing") : t("setup.approve")}
                </Button>
                <Button size="sm" variant="ghost" disabled={action.busy} onClick={() => answer(c, false)}>
                  {t("setup.decline")}
                </Button>
              </div>
              <div className="text-xs break-words text-fg-muted">
                #{c.id} · {c.requestedBy} · {formatTime(c.requestedAt)} · <span className="font-mono break-all">{c.itemId}</span>
              </div>
            </div>
          ))}
        </div>
        <ErrorNote error={action.error} />
        {done ? (
          <Notice tone={done.status === "done" ? "ok" : done.status === "rejected" ? "info" : "error"}>
            {t("setup.answered", {
              id: done.id,
              label: done.label,
              result: done.status === "done" ? t("setup.resultDone") : done.status === "rejected" ? t("setup.resultDeclined") : t("setup.resultFailed"),
            })}
          </Notice>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SetupList({ items, required, onChanged }: { items: SetupItem[]; required: Set<string>; onChanged: (item: SetupItem) => void }) {
  return (
    <>
      {items.map((item) => (
        <SetupRow key={item.id} item={item} required={required.has(item.id)} onChanged={onChanged} />
      ))}
    </>
  );
}

function SetupRow({ item, required, onChanged }: { item: SetupItem; required: boolean; onChanged: (item: SetupItem) => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [output, setOutput] = useState<string | null>(null);
  const Icon = iconOf(item.id);
  return (
    <div className="flex flex-col gap-2 border-b border-line-subtle px-4 py-[11px] last:border-b-0">
      <div className="flex items-center gap-3">
        <span className="grid size-[30px] shrink-0 place-items-center rounded-[7px] bg-sunken text-fg-secondary">
          <Icon className="size-[15px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px]/[18px] font-semibold text-fg-strong">{item.label}</span>
          <span className="truncate font-mono text-xs/4 text-fg-muted" title={item.detail}>
            {item.detail}
          </span>
        </span>
        {required ? <Chip kind="info">{t("setup.required")}</Chip> : null}
        <span className="inline-flex h-[22px] items-center rounded-full px-2">
          <Chip kind={TONE[item.state]}>{t(`setupState.${item.state}`)}</Chip>
        </span>
        {item.action ? (
          <Button
            size="sm"
            variant="outline"
            className="min-w-[84px]"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const r = await client.desktop!.installSetup(item.id);
                setOutput(r.output || null);
                onChanged(r.item);
              })
            }
          >
            {action.busy ? t("setup.installing") : item.action}
          </Button>
        ) : null}
      </div>
      <ErrorNote error={action.error} />
      {output ? (
        <details className="pl-[42px]">
          <summary className="cursor-pointer text-xs text-fg-muted select-none hover:text-fg-strong">{t("setup.output")}</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-line-subtle bg-code p-3 font-mono text-xs text-code-fg">{output}</pre>
        </details>
      ) : null}
    </div>
  );
}
