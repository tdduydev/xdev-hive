// The web's menu entries that hold several pages as tabs (roadmap 49b): Cài đặt dự án, Máy & agent and Quản trị
// (Agent đang chạy lost its tabs in 49e: run groups became a filter). Each tab is a page or card that already existed, drawn as it was; only where it sits changed.
import { useState, type ReactNode } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Page } from "#ui/components/common.tsx";
import { LeaderGuidePanel } from "#ui/components/LeaderGuide.tsx";
import { PageTabs } from "#ui/components/PageTabs.tsx";
import { useHashParam, useHive, usePoll } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import {
  adminTabs,
  machineTabs,
  pickTab,
  settingsTabs,
  webCaps,
  type AdminTab,
  type MachineTab,
  type SettingsTab,
} from "#ui/lib/nav.ts";
import { canEditChatSettings } from "#ui/lib/permission-controls.ts";
import { scopeProject } from "#ui/lib/scope.ts";
import { MemoryCleanupSettings, MemoryCleanupProposals } from "#ui/components/MemoryCleanup.tsx";
import { MemoryPage } from "#ui/pages/Memory.tsx";
import { DocsPage } from "#ui/pages/Docs.tsx";
import { SkillsPage } from "#ui/pages/Skills.tsx";
import { ProposalsPage } from "#ui/pages/Proposals.tsx";
import { PolicyTab } from "./Admin.tsx";
import { CompactAgentPolicy } from "./admin/CompactAgentPolicy.tsx";
import { BudgetsCard } from "./admin/Budgets.tsx";
import { OpsAlerts } from "./admin/Alerts.tsx";
import { OverviewWithRange, OpsPage } from "./admin/frame.tsx";
import { OpsContext, OpsHub } from "./admin/HubOps.tsx";
import { OpsAudit, OpsCosts, OpsFleet, OpsQueue } from "./admin/Ops.tsx";
import { SdlcGatesCard } from "./admin/SdlcGates.tsx";
import { ClassifySettingsCard } from "./admin/ClassifySettings.tsx";
import { OpsVersions } from "./admin/Versions.tsx";
import { BatchesPage } from "./Batches.tsx";
import { QuotaPage } from "#ui/pages/Quota.tsx";
import { MachinesPage } from "./Machines.tsx";
import { MembersPage } from "./Members.tsx";
import { RunsPage } from "./Runs.tsx";
import { SystemsPage } from "./Systems.tsx";
import { ToolsPage } from "./Tools.tsx";
import { UsersPage } from "./Users.tsx";
import { WebhooksTab } from "./Webhooks.tsx";

/** Cài đặt dự án: what a lead sets for their projects, once scattered over six pages (spec 49, "Tech lead"). */
export function SettingsPage() {
  const { client, me, projects, scope } = useHive();
  const t = useT();
  const [wanted] = useHashParam("tab");
  const [editing, setEditing] = useState(false);
  const tabs = settingsTabs(me, projects, webCaps(client));
  const tab = pickTab(tabs, wanted);
  if (!tab) return null;
  const leaderProjects = projects.filter((p) => canEditChatSettings(me, p));
  const body: Record<SettingsTab, () => ReactNode> = {
    policy: () => <div className="max-w-2xl rounded-xl border border-line-default bg-card p-4"><p className="mb-3 text-sm text-fg-secondary">{t("settingsTidy.summary.policy")}</p><a href="#/pipeline" className="inline-flex min-h-11 items-center text-fg-link underline">{t("settingsTidy.openProcess")}</a></div>,
    agent: () => <><CompactAgentPolicy /><details className="mt-4 max-w-2xl"><summary className="flex min-h-11 cursor-pointer items-center text-sm text-fg-link">{t("taskClass.settingsTitle")}</summary><ClassifySettingsCard projects={projects.filter((p) => canEditChatSettings(me, p))} /></details></>,
    tools: () => <ToolsPage />,
    context: () => (
      <OpsPage>
        <OpsContext />
        <MemoryCleanupSettings />
      </OpsPage>
    ),
    leader: () => (
      <Page>
        <LeaderGuidePanel key={leaderProjects.join(",")} projects={leaderProjects} defaultProject={scopeProject(scope)} />
      </Page>
    ),
    members: () => <MembersPage />,
    systems: () => <SystemsPage policy={false} />,
  };
  return <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 p-4 md:flex-row md:p-6" data-settings-tidy>
    <nav aria-label={t("sections.tabs")} className="md:w-52 md:shrink-0"><div className="flex flex-col gap-1">{tabs.map((id) => <a key={id} href={`#/settings?tab=${id}`} data-page-tab={id} aria-current={id === tab ? "page" : undefined} onClick={() => setEditing(false)} className={`flex min-h-11 items-center rounded-lg px-3 text-sm no-underline ${id === tab ? "bg-primary/10 font-semibold text-fg-strong" : "text-fg-secondary hover:bg-muted"}`}>{t(`sections.settings.${id}`)}</a>)}</div></nav>
    <main className="min-w-0 flex-1"><h1 className="mb-3 text-xl font-semibold">{t(`sections.settings.${tab}`)}</h1>
      {tab === "policy" || tab === "agent" ? body[tab]() : <div className="max-w-2xl rounded-xl border border-line-default bg-card p-4"><p className="mb-3 text-sm leading-relaxed text-fg-secondary">{t(`settingsTidy.summary.${tab}`)}</p><Button variant="outline" className="max-md:min-h-11" onClick={() => setEditing(true)}>{t("settingsTidy.edit")}</Button></div>}
      {editing && tab !== "policy" && tab !== "agent" ? <section className="mt-4 max-w-2xl rounded-xl border border-line-default bg-card p-4" data-settings-editor><div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">{t(`sections.settings.${tab}`)}</h2><Button variant="outline" className="max-md:min-h-11" onClick={() => setEditing(false)}>{t("settingsTidy.close")}</Button></div>{body[tab]()}</section> : null}
    </main>
  </div>;
}

/** Máy & agent: the agent map, and for the hub admin the fleet, the queue and the costs of every machine. */
export function MachinesAgentsPage() {
  const { me } = useHive();
  const t = useT();
  const [wanted] = useHashParam("tab");
  const tabs = machineTabs(me);
  const tab = pickTab(tabs, wanted) ?? "map";
  const body: Record<MachineTab, () => ReactNode> = {
    map: () => <MachinesPage />,
    quota: () => <QuotaPage />,
    fleet: () => (
      <OpsPage>
        <OpsFleet />
      </OpsPage>
    ),
    queue: () => (
      <OpsPage>
        <OpsQueue />
      </OpsPage>
    ),
    // Budgets are set on Quản trị › Ngân sách; here only what was spent.
    costs: () => (
      <OpsPage>
        <OpsCosts budgets={false} />
      </OpsPage>
    ),
  };
  return (
    <PageTabs page="machines" tabs={tabs} current={tab} label={t("sections.tabs")} name={(id) => t(`sections.machines.${id}`)}>
      {body[tab]()}
    </PageTabs>
  );
}

/** Quản trị: the hub admin's one entry, a tab per job. */
export function AdminPage() {
  const { client } = useHive();
  const t = useT();
  const [wanted] = useHashParam("tab");
  const tabs = adminTabs(webCaps(client));
  const tab = pickTab(tabs, wanted) ?? "ops";
  const poll = usePoll(30_000);
  const ops = (page: ReactNode) => <OpsPage>{page}</OpsPage>;
  const body: Record<AdminTab, () => ReactNode> = {
    ops: () => <OverviewWithRange />,
    users: () => <UsersPage />,
    policy: () => ops(<><PolicyTab /><CompactAgentPolicy hubOnly /><SdlcGatesCard hubOnly /></>),
    tools: () => <ToolsPage />,
    budgets: () => ops(<BudgetsCard tick={poll} />),
    alerts: () => ops(<OpsAlerts />),
    audit: () => ops(<OpsAudit />),
    webhooks: () => ops(<WebhooksTab />),
    versions: () => ops(<OpsVersions />),
    hub: () => ops(<OpsHub />),
  };
  return (
    <PageTabs page="admin" tabs={tabs} current={tab} label={t("sections.tabs")} name={(id) => t(`sections.admin.${id}`)}>
      {body[tab]()}
    </PageTabs>
  );
}

/**
 * Agent đang chạy on the web: runs with a group filter. Old tab links still open the group management page. The desktop app lists
 * this machine's runs alone (35a), with no groups, so it keeps the page as it was.
 */
export function RunsWorkPage() {
  const { client } = useHive();
  const [wanted] = useHashParam("tab");
  if (client.desktop) return <RunsPage />;
  return wanted === "batches" ? <BatchesPage /> : <RunsPage />;
}

/** Keeping proposals beside their content avoids a separate approval page and preserves its permission checks. */
export function KnowledgePage({ page }: { page: "docs" | "skills" | "memory" }) {
  const t = useT();
  const [wanted] = useHashParam("tab");
  const tab = wanted === "pending" ? "pending" : "content";
  let body: ReactNode;
  if (page === "memory") {
    body = tab === "pending" ? (
      <div className="min-h-0 flex-1 overflow-auto">
        <MemoryCleanupProposals />
        <div className="h-[36rem]"><MemoryPage pendingOnly /></div>
      </div>
    ) : <MemoryPage />;
  } else {
    body = tab === "pending" ? <ProposalsPage kind={page} /> : page === "docs" ? <DocsPage /> : <SkillsPage />;
  }
  return (
    <PageTabs page={page} tabs={["content", "pending"]} current={tab} label={t("sections.tabs")} name={(id) => t(`knowledge.${id}`)}>
      <div className="flex min-h-0 flex-1 flex-col" data-knowledge-page={page}>{body}</div>
    </PageTabs>
  );
}
