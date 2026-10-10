// The web's menu entries that hold several pages as tabs (roadmap 49b): Cài đặt dự án, Máy & agent and Quản trị
// (Agent đang chạy lost its tabs in 49e: run groups became a filter). Each tab is a page or card that already existed, drawn as it was; only where it sits changed.
import { useState, type ReactNode } from "react";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Page } from "#ui/components/common.tsx";
import { LeaderGuidePanel } from "#ui/components/LeaderGuide.tsx";
import { PageTabs } from "#ui/components/PageTabs.tsx";
import { hashParam, useHashParam, useHive, usePoll } from "#ui/hooks.ts";
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
import { MemoryCleanupSettings } from "#ui/components/MemoryCleanup.tsx";
import { MemoryPage } from "#ui/pages/Memory.tsx";
import { DocsPage } from "#ui/pages/Docs.tsx";
import { SkillsPage } from "#ui/pages/Skills.tsx";
import { ProposalsPage } from "#ui/pages/Proposals.tsx";
import { PolicyTab } from "./Admin.tsx";
import { AgentRows, PolicyRows } from "./SettingsRows.tsx";
import { AgentPolicyRows } from "./AgentPolicyRows.tsx";
import { ContextRows, LeaderRows, MemberRows, SystemRows, TabFrame, ToolRows } from "./SettingsTabRows.tsx";
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
import { OrgTab, RolesTab } from "./admin/AccessMaps.tsx";
import { WebhooksTab } from "./Webhooks.tsx";
import { DashboardComponentsFixture } from "./DashboardComponentsFixture.tsx";

/** Cài đặt dự án: what a lead sets for their projects, once scattered over six pages (spec 49, "Tech lead"). */
export function SettingsPage() {
  const { client, me, projects, scope } = useHive();
  const t = useT();
  const [wanted] = useHashParam("tab");
  // The tab being edited, not a flag: a tab reached by address (not a chip) starts on its rows.
  const [editingTab, setEditingTab] = useState<SettingsTab | null>(null);
  const tabs = settingsTabs(me, projects, webCaps(client));
  const tab = pickTab(tabs, wanted);
  if (!tab) return null;
  const editing = editingTab === tab;
  const setEditing = (on: boolean) => setEditingTab(on ? tab : null);
  const leaderProjects = projects.filter((p) => canEditChatSettings(me, p));
  const body: Record<SettingsTab, () => ReactNode> = {
    policy: () => <PolicyRows />,
    agent: () => <AgentRows classify={<details className="mt-4 max-w-2xl" data-classify-details><summary className="flex min-h-11 cursor-pointer items-center text-sm text-fg-link">{t("taskClass.settingsTitle")}</summary><ClassifySettingsCard projects={leaderProjects} /></details>} />,
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
  const summary = tab !== "policy" && tab !== "agent";
  const rows: Record<Exclude<SettingsTab, "policy" | "agent">, () => ReactNode> = {
    tools: () => <ToolRows />,
    context: () => <ContextRows />,
    leader: () => <LeaderRows projects={leaderProjects} />,
    members: () => <MemberRows />,
    systems: () => <SystemRows />,
  };
  // Chips on top, rows below (design lines 1135–1172); the cards that already exist stay as the editors behind "Sửa".
  return <div className="mx-auto h-full w-full max-w-7xl overflow-auto p-4 md:p-6" data-settings-tidy>
    <nav aria-label={t("sections.tabs")} className="cx-chips">{tabs.map((id) => <a key={id} href={`#/settings?tab=${id}`} data-page-tab={id} data-active={id === tab} aria-current={id === tab ? "page" : undefined} onClick={() => setEditing(false)} className="cosmic-tag" data-tone="neutral">{t(`sections.settings.${id}`)}</a>)}</nav>
    <main className="min-w-0"><h1 className="sr-only">{t(`sections.settings.${tab}`)}</h1>
      {summary && !editing ? <TabFrame tab={tab} onEdit={() => setEditing(true)}>{rows[tab]()}</TabFrame> : summary ? null : body[tab]()}
      {editing && summary ? <section className="cx-editor" data-settings-editor><div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-semibold">{t(`sections.settings.${tab}`)}</h2><Button variant="ghost" size="sm" className="max-md:min-h-11" onClick={() => setEditing(false)}>{t("settingsTidy.close")}</Button></div>{body[tab]()}</section> : null}
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
  // Fixture with fake numbers: only when the e2e runner set the session flag, so a hand-typed ?e2e= never replaces the real page.
  const fixture = hashParam("e2e") === "dashboard-components" && sessionStorage.getItem("hive-e2e-fixtures") === "1";
  return fixture ? <DashboardComponentsFixture /> : <AdminTabs />;
}

// Group order is an inference: the design's `adminNav` sits in the truncated part of the template, so only the three-group shape is known.
const ADMIN_GROUPS: { id: "run" | "access" | "system"; items: AdminTab[] }[] = [
  { id: "run", items: ["ops", "budgets", "alerts"] },
  { id: "access", items: ["users", "roles", "org", "policy", "tools"] },
  { id: "system", items: ["audit", "webhooks", "versions", "hub"] },
];

function AdminTabs() {
  const { client } = useHive();
  const t = useT();
  const [wanted] = useHashParam("tab");
  const tabs = adminTabs(webCaps(client));
  const tab = pickTab(tabs, wanted) ?? "ops";
  const poll = usePoll(30_000);
  // The head's action button belongs to the admin page, the dialog it opens to the Users tab: the flag lives where both can reach it.
  const [inviteOpen, setInviteOpen] = useState(false);
  const ops = (page: ReactNode) => <OpsPage>{page}</OpsPage>;
  const body: Record<AdminTab, () => ReactNode> = {
    ops: () => <OverviewWithRange />,
    users: () => <UsersPage inviteOpen={inviteOpen} onInviteClose={() => setInviteOpen(false)} />,
    roles: () => <RolesTab />,
    org: () => <OrgTab />,
    policy: () => ops(<><PolicyTab /><AgentPolicyRows hubOnly /><SdlcGatesCard hubOnly /></>),
    tools: () => <ToolsPage />,
    budgets: () => ops(<BudgetsCard tick={poll} />),
    alerts: () => ops(<OpsAlerts />),
    audit: () => ops(<OpsAudit />),
    webhooks: () => ops(<WebhooksTab />),
    versions: () => ops(<OpsVersions />),
    hub: () => ops(<OpsHub />),
  };
  const groups = ADMIN_GROUPS.map((g) => ({ ...g, items: g.items.filter((id) => tabs.includes(id)) })).filter((g) => g.items.length);
  return (
    <div className="mx-auto h-full w-full max-w-7xl overflow-auto p-4 md:p-6" data-admin-page>
      <nav aria-label={t("sections.tabs")} className="cx-admin-nav">
        {groups.map((g) => (
          <div key={g.id} className="cx-admin-group">
            <span>{t(`sections.adminGroup.${g.id}`)}</span>
            <div>{g.items.map((id) => <a key={id} href={`#/admin?tab=${id}`} data-page-tab={id} aria-current={id === tab ? "page" : undefined} className="cx-admin-tab">{t(`sections.admin.${id}`)}</a>)}</div>
          </div>
        ))}
      </nav>
      <div className="cx-admin-head"><div><h2>{t(`sections.admin.${tab}`)}</h2><p>{t(`sections.adminDesc.${tab}`)}</p></div>{tab === "users" ? <Button variant="solid" size="md" data-admin-action onClick={() => setInviteOpen(true)}>{t("adminUsers.invite")}</Button> : null}</div>
      {body[tab]()}
    </div>
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

/**
 * Keeping proposals beside their content avoids a separate approval page and preserves its permission checks. Docs keep the two
 * tabs; Memory and Skill have none (template hive-2026-10): Memory's "Chờ duyệt" chip and a skill's "N đề xuất" pill lead to what
 * the tab held, and the old ?tab=pending links still land there.
 */
export function KnowledgePage({ page }: { page: "docs" | "skills" | "memory" }) {
  const t = useT();
  const [wanted] = useHashParam("tab");
  const tab = wanted === "pending" ? "pending" : "content";
  if (page === "memory") {
    // Keyed by the address so a link to the pending view opens on that chip even when the page is already shown.
    return <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-knowledge-page={page}><MemoryPage key={tab} pendingFirst={tab === "pending"} /></div>;
  }
  if (page === "skills") {
    return <div className="flex min-h-0 flex-1 flex-col" data-knowledge-page={page}>{tab === "pending" ? <SkillProposals /> : <SkillsPage />}</div>;
  }
  return (
    <PageTabs page={page} tabs={["content", "pending"]} current={tab} label={t("sections.tabs")} name={(id) => t(`knowledge.${id}`)}>
      <div className="flex min-h-0 flex-1 flex-col" data-knowledge-page={page}>{tab === "pending" ? <ProposalsPage kind={page} /> : <DocsPage />}</div>
    </PageTabs>
  );
}

/** A skill's proposals, opened from its "N đề xuất" pill: the proposals page with a way back to the list. */
function SkillProposals() {
  const t = useT();
  return (
    <>
      <a href="#/skills" className="mx-7 mt-4 inline-flex min-h-11 items-center self-start text-fg-link no-underline hover:underline md:min-h-0" data-skills-back>
        ← {t("common.backToList")}
      </a>
      <ProposalsPage kind="skills" />
    </>
  );
}
