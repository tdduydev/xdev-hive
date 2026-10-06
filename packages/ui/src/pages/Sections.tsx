// The web's menu entries that hold several pages as tabs (roadmap 49b): Cài đặt dự án, Máy & agent, Quản trị and
// Agent đang chạy. Each tab is a page or card that already existed, drawn as it was; only where it sits changed.
import type { ReactNode } from "react";
import { Page } from "#ui/components/common.tsx";
import { LeaderGuidePanel } from "#ui/components/LeaderGuide.tsx";
import { PageTabs } from "#ui/components/PageTabs.tsx";
import { useHashParam, useHive, usePoll } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import {
  adminTabs,
  isHubAdmin,
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
import { PolicyTab } from "./Admin.tsx";
import { AgentPolicyCard } from "./admin/AgentPolicy.tsx";
import { BudgetsCard } from "./admin/Budgets.tsx";
import { OpsAlerts } from "./admin/Alerts.tsx";
import { OverviewWithRange, OpsPage } from "./admin/frame.tsx";
import { OpsContext, OpsHub } from "./admin/HubOps.tsx";
import { OpsAudit, OpsCosts, OpsFleet, OpsQueue } from "./admin/Ops.tsx";
import { SdlcGatesCard } from "./admin/SdlcGates.tsx";
import { OpsVersions } from "./admin/Versions.tsx";
import { BatchesPage } from "./Batches.tsx";
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
  const tabs = settingsTabs(me, projects, webCaps(client));
  const tab = pickTab(tabs, wanted);
  if (!tab) return null;
  const leaderProjects = projects.filter((p) => canEditChatSettings(me, p));
  const body: Record<SettingsTab, () => ReactNode> = {
    // The hub admin's whole policy page, which ends with every project's rows; a lead edits the rows of their own.
    policy: () =>
      isHubAdmin(me) ? (
        <OpsPage>
          <PolicyTab />
        </OpsPage>
      ) : (
        <Page>
          <AgentPolicyCard editableOnly />
          <SdlcGatesCard editableOnly />
        </Page>
      ),
    tools: () => <ToolsPage />,
    context: () => (
      <OpsPage>
        <OpsContext />
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
  return (
    <PageTabs page="settings" tabs={tabs} current={tab} label={t("sections.tabs")} name={(id) => t(`sections.settings.${id}`)}>
      {body[tab]()}
    </PageTabs>
  );
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
