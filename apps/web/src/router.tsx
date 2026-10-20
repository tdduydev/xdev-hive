import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { meQuery } from "@/lib/me.ts";
import { orgsMineQuery } from "@/lib/orgs.ts";
import { authRedirect, legacyRedirect } from "@/lib/redirect.ts";
import {
  validateAuditSearch,
  validateLeaderSearch,
  validateLoginSearch,
  validateMachineSearch,
  validateMachinesSearch,
  validateMcpSearch,
  validateMemberSearch,
  validateMembersSearch,
  validateMemorySearch,
  validateNotificationsSearch,
  validateOnboardingSearch,
  validateProposalSearch,
  validateProposalsSearch,
  validateReviewsSearch,
  validateRoleSearch,
  validateSdlcBoardSearch,
  validateSkillSearch,
  validateSkillsSearch,
  validateTasksSearch,
  validateTeamSearch,
  validateTeamsSearch,
  validateWorkflowsSearch,
} from "@/lib/route-search.ts";
import { validateRunsSearch } from "@/lib/run-list.ts";
import { stashPairSecret } from "@/lib/terminal/webauthn.ts";

import { LoadErrorPage, NotFoundPage, PendingPage } from "@/pages/status-pages.tsx";
import { AppShell } from "@/shell/app-shell.tsx";
import { OrgGate } from "@/shell/org-gate.tsx";
import { SessionLayout } from "@/shell/session-layout.tsx";

/*
 * Mỗi trang là một chunk riêng, tải khi vào route (hoặc khi rê chuột lên link, nhờ defaultPreload). Bundle đầu chỉ còn
 * router, khung app và thư viện dùng chung, nên trang đầu tiên hiện nhanh hơn.
 */
const ArtifactDetailPage = lazyRouteComponent(() => import("@/pages/artifacts/detail-page.tsx"), "ArtifactDetailPage");
const ArtifactLibraryPage = lazyRouteComponent(
  () => import("@/pages/artifacts/library-page.tsx"),
  "ArtifactLibraryPage",
);
const AuditPage = lazyRouteComponent(() => import("@/pages/admin/audit-page.tsx"), "AuditPage");
const GitConnectionsPage = lazyRouteComponent(() => import("@/pages/admin/git-page.tsx"), "GitConnectionsPage");
const McpPage = lazyRouteComponent(() => import("@/pages/admin/mcp-page.tsx"), "McpPage");
const PoliciesPage = lazyRouteComponent(() => import("@/pages/admin/policies-page.tsx"), "PoliciesPage");
const RemotePage = lazyRouteComponent(() => import("@/pages/remote/remote-page.tsx"), "RemotePage");
const RemoteSessionPage = lazyRouteComponent(() => import("@/pages/remote/session-page.tsx"), "RemoteSessionPage");
const RemotePairPage = lazyRouteComponent(() => import("@/pages/remote/pair-page.tsx"), "RemotePairPage");
const RemoteDevicesPage = lazyRouteComponent(() => import("@/pages/remote/devices-page.tsx"), "RemoteDevicesPage");
const PublicLinksPage = lazyRouteComponent(() => import("@/pages/admin/public-links-page.tsx"), "PublicLinksPage");
const RolesPage = lazyRouteComponent(() => import("@/pages/admin/roles-page.tsx"), "RolesPage");
const RoleDetailPage = lazyRouteComponent(() => import("@/pages/admin/roles-page.tsx"), "RoleDetailPage");
const CostsPage = lazyRouteComponent(() => import("@/pages/costs-page.tsx"), "CostsPage");
const DesktopConnectPage = lazyRouteComponent(() => import("@/pages/desktop-connect-page.tsx"), "DesktopConnectPage");
const HomePage = lazyRouteComponent(() => import("@/pages/home-page.tsx"), "HomePage");
const InvitePage = lazyRouteComponent(() => import("@/pages/invite-page.tsx"), "InvitePage");
const DocEditorPage = lazyRouteComponent(() => import("@/pages/knowledge/doc-editor-page.tsx"), "DocEditorPage");
const DocImportPage = lazyRouteComponent(() => import("@/pages/knowledge/doc-import-page.tsx"), "DocImportPage");
const DocConflictPage = lazyRouteComponent(() => import("@/pages/knowledge/doc-conflict-page.tsx"), "DocConflictPage");
const DocExtractsPage = lazyRouteComponent(() => import("@/pages/knowledge/doc-extracts-page.tsx"), "DocExtractsPage");
const DocsPage = lazyRouteComponent(() => import("@/pages/knowledge/docs-page.tsx"), "DocsPage");
const MemoryDetailPage = lazyRouteComponent(() => import("@/pages/knowledge/memory-page.tsx"), "MemoryDetailPage");
const MemoryPage = lazyRouteComponent(() => import("@/pages/knowledge/memory-page.tsx"), "MemoryPage");
const ProposalDetailPage = lazyRouteComponent(
  () => import("@/pages/knowledge/proposals-page.tsx"),
  "ProposalDetailPage",
);
const ProposalsPage = lazyRouteComponent(() => import("@/pages/knowledge/proposals-page.tsx"), "ProposalsPage");
const ReviewsPage = lazyRouteComponent(() => import("@/pages/knowledge/reviews-page.tsx"), "ReviewsPage");
const SkillDetailPage = lazyRouteComponent(() => import("@/pages/knowledge/skills-page.tsx"), "SkillDetailPage");
const SkillsPage = lazyRouteComponent(() => import("@/pages/knowledge/skills-page.tsx"), "SkillsPage");
const WorkflowsPage = lazyRouteComponent(() => import("@/pages/knowledge/workflows-page.tsx"), "WorkflowsPage");
const WordImportPage = lazyRouteComponent(() => import("@/pages/knowledge/word-import-page.tsx"), "WordImportPage");
const WordImportsPage = lazyRouteComponent(() => import("@/pages/knowledge/word-imports-page.tsx"), "WordImportsPage");
const LeaderPage = lazyRouteComponent(() => import("@/pages/leader-page.tsx"), "LeaderPage");
const LeaderTerminalPage = lazyRouteComponent(() => import("@/pages/leader-terminal-page.tsx"), "LeaderTerminalPage");
const LoginPage = lazyRouteComponent(() => import("@/pages/login-page.tsx"), "LoginPage");
const LoginSettingsPage = lazyRouteComponent(() => import("@/pages/login-settings-page.tsx"), "LoginSettingsPage");
const MachineDetailPage = lazyRouteComponent(() => import("@/pages/machines-page.tsx"), "MachineDetailPage");
const MachinesPage = lazyRouteComponent(() => import("@/pages/machines-page.tsx"), "MachinesPage");
const McpConsentPage = lazyRouteComponent(() => import("@/pages/mcp-consent-page.tsx"), "McpConsentPage");
const MemberDetailPage = lazyRouteComponent(() => import("@/pages/members-page.tsx"), "MemberDetailPage");
const MembersPage = lazyRouteComponent(() => import("@/pages/members-page.tsx"), "MembersPage");
const MergeQueuePage = lazyRouteComponent(() => import("@/pages/merge-queue-page.tsx"), "MergeQueuePage");
const NotificationsPage = lazyRouteComponent(() => import("@/pages/notifications-page.tsx"), "NotificationsPage");
const OnboardingPage = lazyRouteComponent(() => import("@/pages/onboarding-page.tsx"), "OnboardingPage");
const PlanPage = lazyRouteComponent(() => import("@/pages/plan-page.tsx"), "PlanPage");
const ProjectSettingsPage = lazyRouteComponent(
  () => import("@/pages/project-settings-page.tsx"),
  "ProjectSettingsPage",
);
const ProjectsPage = lazyRouteComponent(() => import("@/pages/projects-page.tsx"), "ProjectsPage");
const RunPage = lazyRouteComponent(() => import("@/pages/run-page.tsx"), "RunPage");
const RunsPage = lazyRouteComponent(() => import("@/pages/runs-page.tsx"), "RunsPage");
const ProjectSandboxPage = lazyRouteComponent(() => import("@/pages/sandbox-pages.tsx"), "ProjectSandboxPage");
const SandboxAdminPage = lazyRouteComponent(() => import("@/pages/sandbox-pages.tsx"), "SandboxAdminPage");
const SdlcMetricsPage = lazyRouteComponent(() => import("@/pages/sdlc/metrics-page.tsx"), "SdlcMetricsPage");
const CiConnectionsPage = lazyRouteComponent(
  () => import("@/pages/settings/ci-connections-page.tsx"),
  "CiConnectionsPage",
);
const JenkinsTokensPage = lazyRouteComponent(
  () => import("@/pages/settings/jenkins-tokens-page.tsx"),
  "JenkinsTokensPage",
);
const CiCdPage = lazyRouteComponent(() => import("@/pages/projects/cicd-page.tsx"), "CiCdPage");
const ServersPage = lazyRouteComponent(() => import("@/pages/settings/servers-page.tsx"), "ServersPage");
const EnvironmentsPage = lazyRouteComponent(() => import("@/pages/settings/environments-page.tsx"), "EnvironmentsPage");
const DeployBoardPage = lazyRouteComponent(() => import("@/pages/deploys/board-page.tsx"), "DeployBoardPage");
const DeployPage = lazyRouteComponent(() => import("@/pages/deploys/deploy-page.tsx"), "DeployPage");
const SdlcModesPage = lazyRouteComponent(() => import("@/pages/admin/sdlc-modes-page.tsx"), "SdlcModesPage");
const SdlcFleetPage = lazyRouteComponent(() => import("@/pages/sdlc/fleet-page.tsx"), "SdlcFleetPage");
const SdlcBoardPage = lazyRouteComponent(() => import("@/pages/sdlc/sdlc-pages.tsx"), "SdlcBoardPage");
const SdlcItemPage = lazyRouteComponent(() => import("@/pages/sdlc/sdlc-pages.tsx"), "SdlcItemPage");
const SdlcNewPage = lazyRouteComponent(() => import("@/pages/sdlc/sdlc-pages.tsx"), "SdlcNewPage");
const SdlcQuestionsPage = lazyRouteComponent(() => import("@/pages/sdlc/sdlc-pages.tsx"), "SdlcQuestionsPage");
const ProjectTasksPage = lazyRouteComponent(() => import("@/pages/tasks-page.tsx"), "ProjectTasksPage");
const TasksPage = lazyRouteComponent(() => import("@/pages/tasks-page.tsx"), "TasksPage");
const TeamDetailPage = lazyRouteComponent(() => import("@/pages/teams-page.tsx"), "TeamDetailPage");
const TeamsPage = lazyRouteComponent(() => import("@/pages/teams-page.tsx"), "TeamsPage");

/*
 * Khai báo route bằng code, không dùng file-based: hiện chỉ có vài route, và file-based cần plugin Vite sinh
 * routeTree.gen.ts phải commit và giữ khớp (CI chạy typecheck không qua Vite). Kiểu của route, search, context vẫn
 * được suy ra đầy đủ. Khi số màn tăng (M2 trở đi) có thể chuyển sang file-based mà không đổi code trang.
 */

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  // Guard đặt ở gốc để cả đường dẫn không tồn tại cũng chuyển về /login khi chưa đăng nhập.
  beforeLoad: async ({ context, location, matches }) => {
    // Đường dẫn cũ đổi trước khi xét đăng nhập, để `?redirect=` sau đăng nhập đã là đường dẫn mới.
    const moved = legacyRedirect(location);
    if (moved) throw redirect({ href: moved, replace: true });
    // Trang sau đăng nhập (sessionRoute) hỏi orgs.mine ngay sau me.get: hỏi cùng lúc cho đỡ một lượt đi về. Chưa đăng
    // nhập thì lời gọi nhận 401 và bị bỏ qua; sessionRoute vẫn tự hỏi lại khi cache chưa có dữ liệu.
    if (matches.some((m) => m.routeId === sessionRoute.id)) {
      context.queryClient.ensureQueryData(orgsMineQuery).catch(() => {});
    }
    const me = await context.queryClient.ensureQueryData(meQuery);
    const { redirect: back } = location.search as { redirect?: unknown };
    // Link ghép mang bí mật trong fragment: chưa đăng nhập thì cất bí mật lại để `?redirect=` không mang nó lên hub.
    const from = me === null ? stashPairSecret(location.href) : location.href;
    const href = authRedirect({ pathname: location.pathname, href: from, redirect: back }, me !== null);
    if (href) throw redirect({ href, replace: true });
  },
  component: Outlet,
  pendingComponent: PendingPage,
  errorComponent: LoadErrorPage,
  notFoundComponent: NotFoundPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: validateLoginSearch,
  component: LoginPage,
});

/** Link mời /invite/<mã>: mở được khi chưa đăng nhập (lib/redirect.ts), đứng ngoài khung app như trang đăng nhập. */
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: InvitePage,
});

/** Trang đồng ý của luồng OAuth cho client MCP; đứng riêng ngoài khung app vì người dùng đến từ CLI. */
const mcpConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mcp/consent",
  component: McpConsentPage,
});

/** Mọi trang sau đăng nhập cần biết người dùng thuộc tổ chức nào; tải một lần ở đây. */
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "session",
  beforeLoad: ({ context }) => context.queryClient.ensureQueryData(orgsMineQuery),
  component: SessionLayout,
});

/** Trang đồng ý của app desktop đăng nhập bằng trình duyệt; cần phiên đăng nhập nhưng đứng ngoài khung app. */
const desktopConnectRoute = createRoute({
  getParentRoute: () => sessionRoute,
  path: "/desktop/connect",
  component: DesktopConnectPage,
});

/**
 * Màn tạo tổ chức đứng riêng, không có sidebar, như mockup màn 2. Bước 1 chỉ cho người được tạo tổ chức; bước 2, 3
 * (tạo đội, mời người) chạy sau khi đã tạo, lúc hub có thể đã thôi cho tạo thêm, nên chỉ cần đã thuộc tổ chức.
 */
const onboardingRoute = createRoute({
  getParentRoute: () => sessionRoute,
  path: "/orgs/new",
  validateSearch: validateOnboardingSearch,
  beforeLoad: async ({ context, search }) => {
    const mine = await context.queryClient.ensureQueryData(orgsMineQuery);
    if (!search.buoc && !mine.canCreateOrg) throw redirect({ to: "/", replace: true });
    if (search.buoc && mine.orgs.length === 0) throw redirect({ to: "/orgs/new", replace: true });
  },
  component: OnboardingPage,
});

/** Layout không có path: mọi trang cần đăng nhập nằm trong khung app. */
const appRoute = createRoute({
  getParentRoute: () => sessionRoute,
  id: "app",
  beforeLoad: async ({ context }) => {
    const mine = await context.queryClient.ensureQueryData(orgsMineQuery);
    // Người đầu tiên của hub vào thẳng màn tạo tổ chức; người khác chưa có tổ chức thì ở trang chủ chờ lời mời.
    if (mine.orgs.length === 0 && mine.canCreateOrg) throw redirect({ to: "/orgs/new", replace: true });
  },
  component: AppShell,
});

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomePage });

/** Trang chỉ có nghĩa trong một tổ chức. */
const inOrgRoute = createRoute({
  getParentRoute: () => appRoute,
  id: "in-org",
  beforeLoad: async ({ context }) => {
    const mine = await context.queryClient.ensureQueryData(orgsMineQuery);
    if (mine.orgs.length === 0) throw redirect({ to: "/", replace: true });
  },
  component: OrgGate,
});

const tasksRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/tasks",
  validateSearch: validateTasksSearch,
  component: TasksPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/projects",
  component: ProjectsPage,
});

const projectSandboxRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/projects/$key/sandbox",
  component: ProjectSandboxPage,
});

const sandboxAdminRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/admin/sandbox",
  component: SandboxAdminPage,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/projects/$key/settings",
  component: ProjectSettingsPage,
});

const projectTasksRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/projects/$key",
  validateSearch: validateTasksSearch,
  component: ProjectTasksPage,
});

/** Kế hoạch của plan mode: theo key của task như mọi đường dẫn tới task (/tasks/<key>). */
const planRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/tasks/$key/plan",
  component: PlanPage,
});

const leaderRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/leader",
  validateSearch: validateLeaderSearch,
  component: LeaderPage,
});

/** Phiên terminal Leader: xterm.js nặng nên cả trang là một chunk riêng, chỉ tải khi mở phiên. */
const leaderTerminalRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/leader/terminal/$id",
  component: LeaderTerminalPage,
});

/** Điều khiển từ xa (specs/010): danh sách phiên và phát lại; xterm.js nặng nên trang phiên là chunk riêng. */
const remoteRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/remote",
  component: RemotePage,
});
const remoteSessionRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/remote/$id",
  component: RemoteSessionPage,
});
/** Trang mở từ mã QR của máy: `?m=<tên máy>&p=<pairId>#s=<bí mật>`; trang tự đọc fragment nên search chỉ giữ m, p. */
const remotePairRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/remote/pair",
  validateSearch: (search: Record<string, unknown>): { m?: string; p?: string } => ({
    ...(typeof search.m === "string" && { m: search.m }),
    ...(typeof search.p === "string" && { p: search.p }),
  }),
  component: RemotePairPage,
});
const remoteDevicesRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/remote/devices",
  validateSearch: (search: Record<string, unknown>): { machine?: string } =>
    typeof search.machine === "string" && search.machine ? { machine: search.machine } : {},
  component: RemoteDevicesPage,
});

/** Artifact (specs/012): thư viện, chi tiết; `/v/$n` là đường dẫn phiên bản mà agent dán vào chữ trả lời. */
const artifactsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/artifacts",
  component: ArtifactLibraryPage,
});
const artifactRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/artifacts/$id",
  component: ArtifactDetailPage,
});
const artifactVersionRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/artifacts/$id/v/$n",
  component: ArtifactDetailPage,
});

const runsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/runs",
  validateSearch: validateRunsSearch,
  component: RunsPage,
});

const runRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/runs/$id",
  component: RunPage,
});

const teamsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/admin/teams",
  validateSearch: validateTeamsSearch,
  beforeLoad: ({ search }) => {
    if (search.doi)
      throw redirect({ to: "/admin/teams/$teamId", params: { teamId: search.doi }, search: {}, replace: true });
  },
  component: TeamsPage,
});

const teamRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/admin/teams/$teamId",
  validateSearch: validateTeamSearch,
  component: TeamDetailPage,
});

const membersRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/admin/members",
  validateSearch: validateMembersSearch,
  component: MembersPage,
});

const memberRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/admin/members/$userId",
  validateSearch: validateMemberSearch,
  component: MemberDetailPage,
});

const loginSettingsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/admin/sign-in-settings",
  component: LoginSettingsPage,
});

const mergeQueueRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/projects/$key/merge-queue",
  component: MergeQueuePage,
});

const notificationsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/notifications",
  validateSearch: validateNotificationsSearch,
  component: NotificationsPage,
});
const machinesRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/machines",
  validateSearch: validateMachinesSearch,
  component: MachinesPage,
});
const machineRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/machines/$machineId",
  validateSearch: validateMachineSearch,
  component: MachineDetailPage,
});
const gitRoute = createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/git", component: GitConnectionsPage });
const costsRoute = createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/costs", component: CostsPage });

/** Trang một vai trò (ADMIN-G3): danh sách /admin/roles nằm trong v2Routes. */
const roleRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/admin/roles/$roleId",
  validateSearch: validateRoleSearch,
  component: RoleDetailPage,
});

/**
 * AI SDLC (specs/011 T054). Đường dẫn tĩnh `new`, `questions`, `metrics` thắng đường dẫn có tham số cùng độ dài; key dự án luôn
 * bắt đầu bằng chữ và số hạng mục là số nên hai loại không lẫn.
 */
const sdlcRoutes = [
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/sdlc-modes", component: SdlcModesPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/sdlc/fleet", component: SdlcFleetPage }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/sdlc",
    validateSearch: validateSdlcBoardSearch,
    component: SdlcBoardPage,
  }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/sdlc/new", component: SdlcNewPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/sdlc/questions", component: SdlcQuestionsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/sdlc/metrics", component: SdlcMetricsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/sdlc/$project/$number", component: SdlcItemPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/sdlc/$project/$number/$tab", component: SdlcItemPage }),
];

/** CI/CD và triển khai (specs/020). Trang của T021–T023 thay nội dung các trang rỗng, không đổi đường dẫn. */
const deliveryRoutes = [
  createRoute({ getParentRoute: () => inOrgRoute, path: "/projects/$key/cicd", component: CiCdPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/systems/$systemId/deploys", component: DeployBoardPage }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/systems/$systemId/environments",
    component: EnvironmentsPage,
  }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/deploys/$id", component: DeployPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/servers", component: ServersPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/ci-connections", component: CiConnectionsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/settings/jenkins-tokens", component: JenkinsTokensPage }),
];

/** Màn của thiết kế v2 (docs/design-system/screens) ở nhóm Kiến thức và quản trị. */
const v2Routes = [
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs", component: DocsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs/import", component: DocImportPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs/conflicts/$id", component: DocConflictPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs/extracts", component: DocExtractsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs/word-imports", component: WordImportsPage }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/docs/word-imports/$id",
    component: WordImportPage,
  }),

  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs/$key/edit", component: DocEditorPage }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/skills",
    validateSearch: validateSkillsSearch,
    component: SkillsPage,
  }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/skills/$skillId",
    validateSearch: validateSkillSearch,
    component: SkillDetailPage,
  }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/memory",
    validateSearch: validateMemorySearch,
    component: MemoryPage,
  }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/memory/$memoryId", component: MemoryDetailPage }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/proposals",
    validateSearch: validateProposalsSearch,
    component: ProposalsPage,
  }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/proposals/$proposalId",
    validateSearch: validateProposalSearch,
    component: ProposalDetailPage,
  }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/workflows",
    validateSearch: validateWorkflowsSearch,
    component: WorkflowsPage,
  }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/reviews",
    validateSearch: validateReviewsSearch,
    component: ReviewsPage,
  }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/roles", component: RolesPage }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/admin/mcp",
    validateSearch: validateMcpSearch,
    component: McpPage,
  }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/policies", component: PoliciesPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/public-links", component: PublicLinksPage }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/admin/audit",
    validateSearch: validateAuditSearch,
    component: AuditPage,
  }),
];

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  mcpConsentRoute,
  sessionRoute.addChildren([
    onboardingRoute,
    desktopConnectRoute,
    appRoute.addChildren([
      homeRoute,
      inOrgRoute.addChildren([
        tasksRoute,
        projectsRoute,
        projectTasksRoute,
        projectSettingsRoute,
        projectSandboxRoute,
        sandboxAdminRoute,
        planRoute,
        runsRoute,
        leaderRoute,
        leaderTerminalRoute,
        remoteRoute,
        remotePairRoute,
        remoteDevicesRoute,
        remoteSessionRoute,
        artifactsRoute,
        artifactRoute,
        artifactVersionRoute,
        runRoute,
        teamsRoute,
        teamRoute,
        membersRoute,
        memberRoute,
        loginSettingsRoute,
        mergeQueueRoute,
        notificationsRoute,
        machinesRoute,
        machineRoute,
        gitRoute,
        costsRoute,
        roleRoute,
        ...v2Routes,
        ...sdlcRoutes,
        ...deliveryRoutes,
      ]),
    ]),
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Dữ liệu do TanStack Query giữ cache; router không cache thêm để không lệch nhau.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
  // Router chỉ tải chunk của trang sau khi mọi beforeLoad (me.get rồi orgs.mine) xong. Tải ngay khi bắt đầu chuyển
  // trang thì chunk về song song với các lời gọi đó, trang vẽ sớm hơn một lượt đi về. Chunk đã tải thì không tải lại.
  router.subscribe("onBeforeLoad", ({ toLocation }) => {
    const [routes] = router.getMatchedRoutes(toLocation.pathname);
    for (const route of routes) router.loadRouteChunk(route)?.catch(() => {});
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
