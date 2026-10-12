import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { meQuery } from "@/lib/me.ts";
import { NAV_GROUPS } from "@/lib/nav.ts";
import { orgsMineQuery } from "@/lib/orgs.ts";
import { authRedirect, legacyRedirect } from "@/lib/redirect.ts";
import { validateRunsSearch } from "@/lib/run-list.ts";
import { AuditPage } from "@/pages/admin/audit-page.tsx";
import { McpPage } from "@/pages/admin/mcp-page.tsx";
import { RolesPage } from "@/pages/admin/roles-page.tsx";
import { ComingSoonPage } from "@/pages/coming-soon-page.tsx";
import { CostsPage } from "@/pages/costs-page.tsx";
import { HomePage } from "@/pages/home-page.tsx";
import { InvitePage } from "@/pages/invite-page.tsx";
import { DocsPage } from "@/pages/knowledge/docs-page.tsx";
import { MemoryPage } from "@/pages/knowledge/memory-page.tsx";
import { ProposalsPage } from "@/pages/knowledge/proposals-page.tsx";
import { SkillsPage } from "@/pages/knowledge/skills-page.tsx";
import { LeaderPage, validateLeaderSearch } from "@/pages/leader-page.tsx";
import { LoginPage, validateLoginSearch } from "@/pages/login-page.tsx";
import { LoginSettingsPage } from "@/pages/login-settings-page.tsx";
import { MachinesPage } from "@/pages/machines-page.tsx";
import { McpConsentPage } from "@/pages/mcp-consent-page.tsx";
import { MembersPage, validateMembersSearch } from "@/pages/members-page.tsx";
import { MergeQueuePage } from "@/pages/merge-queue-page.tsx";
import { NotificationsPage } from "@/pages/notifications-page.tsx";
import { OnboardingPage, validateOnboardingSearch } from "@/pages/onboarding-page.tsx";
import { PlanPage } from "@/pages/plan-page.tsx";
import { ProjectSettingsPage } from "@/pages/project-settings-page.tsx";
import { ProjectsPage } from "@/pages/projects-page.tsx";
import { RunPage } from "@/pages/run-page.tsx";
import { RunsPage } from "@/pages/runs-page.tsx";
import { ProjectSandboxPage, SandboxAdminPage } from "@/pages/sandbox-pages.tsx";
import { LoadErrorPage, NotFoundPage, PendingPage } from "@/pages/status-pages.tsx";
import { ProjectTasksPage, TasksPage, validateTasksSearch } from "@/pages/tasks-page.tsx";
import { TeamsPage, validateTeamsSearch } from "@/pages/teams-page.tsx";
import { AppShell } from "@/shell/app-shell.tsx";
import { OrgGate } from "@/shell/org-gate.tsx";
import { SessionLayout } from "@/shell/session-layout.tsx";

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
  beforeLoad: async ({ context, location }) => {
    // Đường dẫn cũ đổi trước khi xét đăng nhập, để `?redirect=` sau đăng nhập đã là đường dẫn mới.
    const moved = legacyRedirect(location);
    if (moved) throw redirect({ href: moved, replace: true });
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
const machinesRoute = createRoute({ getParentRoute: () => inOrgRoute, path: "/machines", component: MachinesPage });
const costsRoute = createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/costs", component: CostsPage });

/**
 * Màn của thiết kế v2 chưa làm (docs/design-system/screens): route có sẵn để sidebar và ⌘K không dẫn tới trang lỗi.
 * Task làm màn thật thay component của route tương ứng.
 */
const comingSoon = (id: string, path: string, design: string) => {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === id);
  if (!item) throw new Error(`Thiếu mục ${id} trong lib/nav.ts`);
  return createRoute({
    getParentRoute: () => inOrgRoute,
    path,
    component: () => <ComingSoonPage item={item} design={design} />,
  });
};
const comingSoonRoutes = [
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/docs", component: DocsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/skills", component: SkillsPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/memory", component: MemoryPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/knowledge/proposals", component: ProposalsPage }),
  comingSoon("workflows", "/knowledge/workflows", "Workflows.dc.html"),
  comingSoon("reviews", "/knowledge/reviews", "DocReview.dc.html"),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/roles", component: RolesPage }),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/mcp", component: McpPage }),
  comingSoon("policies", "/admin/policies", "Policies.dc.html"),
  createRoute({ getParentRoute: () => inOrgRoute, path: "/admin/audit", component: AuditPage }),
];

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  mcpConsentRoute,
  sessionRoute.addChildren([
    onboardingRoute,
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
        costsRoute,
        ...comingSoonRoutes,
      ]),
    ]),
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Dữ liệu do TanStack Query giữ cache; router không cache thêm để không lệch nhau.
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
