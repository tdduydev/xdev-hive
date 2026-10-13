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
  validateLeaderSearch,
  validateLoginSearch,
  validateMachinesSearch,
  validateMembersSearch,
  validateOnboardingSearch,
  validateReviewsSearch,
  validateTasksSearch,
  validateTeamsSearch,
} from "@/lib/route-search.ts";
import { validateRunsSearch } from "@/lib/run-list.ts";

import { LoadErrorPage, NotFoundPage, PendingPage } from "@/pages/status-pages.tsx";
import { AppShell } from "@/shell/app-shell.tsx";
import { OrgGate } from "@/shell/org-gate.tsx";
import { SessionLayout } from "@/shell/session-layout.tsx";

/*
 * Mỗi trang là một chunk riêng, tải khi vào route (hoặc khi rê chuột lên link, nhờ defaultPreload). Bundle đầu chỉ còn
 * router, khung app và thư viện dùng chung, nên trang đầu tiên hiện nhanh hơn.
 */
const AuditPage = lazyRouteComponent(() => import("@/pages/admin/audit-page.tsx"), "AuditPage");
const GitConnectionsPage = lazyRouteComponent(() => import("@/pages/admin/git-page.tsx"), "GitConnectionsPage");
const McpPage = lazyRouteComponent(() => import("@/pages/admin/mcp-page.tsx"), "McpPage");
const PoliciesPage = lazyRouteComponent(() => import("@/pages/admin/policies-page.tsx"), "PoliciesPage");
const RolesPage = lazyRouteComponent(() => import("@/pages/admin/roles-page.tsx"), "RolesPage");
const CostsPage = lazyRouteComponent(() => import("@/pages/costs-page.tsx"), "CostsPage");
const DesktopConnectPage = lazyRouteComponent(() => import("@/pages/desktop-connect-page.tsx"), "DesktopConnectPage");
const HomePage = lazyRouteComponent(() => import("@/pages/home-page.tsx"), "HomePage");
const InvitePage = lazyRouteComponent(() => import("@/pages/invite-page.tsx"), "InvitePage");
const DocEditorPage = lazyRouteComponent(() => import("@/pages/knowledge/doc-editor-page.tsx"), "DocEditorPage");
const DocsPage = lazyRouteComponent(() => import("@/pages/knowledge/docs-page.tsx"), "DocsPage");
const MemoryPage = lazyRouteComponent(() => import("@/pages/knowledge/memory-page.tsx"), "MemoryPage");
const ProposalsPage = lazyRouteComponent(() => import("@/pages/knowledge/proposals-page.tsx"), "ProposalsPage");
const ReviewsPage = lazyRouteComponent(() => import("@/pages/knowledge/reviews-page.tsx"), "ReviewsPage");
const SkillsPage = lazyRouteComponent(() => import("@/pages/knowledge/skills-page.tsx"), "SkillsPage");
const WorkflowsPage = lazyRouteComponent(() => import("@/pages/knowledge/workflows-page.tsx"), "WorkflowsPage");
const LeaderPage = lazyRouteComponent(() => import("@/pages/leader-page.tsx"), "LeaderPage");
const LoginPage = lazyRouteComponent(() => import("@/pages/login-page.tsx"), "LoginPage");
const LoginSettingsPage = lazyRouteComponent(() => import("@/pages/login-settings-page.tsx"), "LoginSettingsPage");
const MachinesPage = lazyRouteComponent(() => import("@/pages/machines-page.tsx"), "MachinesPage");
const McpConsentPage = lazyRouteComponent(() => import("@/pages/mcp-consent-page.tsx"), "McpConsentPage");
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
const ProjectTasksPage = lazyRouteComponent(() => import("@/pages/tasks-page.tsx"), "ProjectTasksPage");
const TasksPage = lazyRouteComponent(() => import("@/pages/tasks-page.tsx"), "TasksPage");
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
    const href = authRedirect({ pathname: location.pathname, href: location.href, redirect: back }, me !== null);
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
  component: TeamsPage,
});

const membersRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/admin/members",
  validateSearch: validateMembersSearch,
  component: MembersPage,
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
  component: NotificationsPage,
});
const machinesRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/machines",
  validateSearch: validateMachinesSearch,
  component: MachinesPage,
});
const gitRoute = createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/git", component: GitConnectionsPage });
const costsRoute = createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/costs", component: CostsPage });

/** Màn của thiết kế v2 (docs/design-system/screens) ở nhóm Kiến thức và quản trị. */
const v2Routes = [
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs", component: DocsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs/$key/edit", component: DocEditorPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/skills", component: SkillsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/memory", component: MemoryPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/proposals", component: ProposalsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/workflows", component: WorkflowsPage }),
  createRoute({
    getParentRoute: () => inOrgRoute,
    path: "/knowledge/reviews",
    validateSearch: validateReviewsSearch,
    component: ReviewsPage,
  }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/roles", component: RolesPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/mcp", component: McpPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/policies", component: PoliciesPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/audit", component: AuditPage }),
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
        runRoute,
        teamsRoute,
        membersRoute,
        loginSettingsRoute,
        mergeQueueRoute,
        notificationsRoute,
        machinesRoute,
        gitRoute,
        costsRoute,
        ...v2Routes,
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
