import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { meQuery } from "./lib/me.ts";
import { orgsMineQuery } from "./lib/orgs.ts";
import { authRedirect } from "./lib/redirect.ts";
import { HomePage } from "./pages/home-page.tsx";
import { InvitePage } from "./pages/invite-page.tsx";
import { LoginPage, validateLoginSearch } from "./pages/login-page.tsx";
import { LoginSettingsPage } from "./pages/login-settings-page.tsx";
import { McpConsentPage } from "./pages/mcp-consent-page.tsx";
import { MembersPage, validateMembersSearch } from "./pages/members-page.tsx";
import { OnboardingPage, validateOnboardingSearch } from "./pages/onboarding-page.tsx";
import { LoadErrorPage, NotFoundPage, PendingPage } from "./pages/status-pages.tsx";
import { TeamsPage, validateTeamsSearch } from "./pages/teams-page.tsx";
import { AppShell } from "./shell/app-shell.tsx";
import { OrgGate } from "./shell/org-gate.tsx";
import { SessionLayout } from "./shell/session-layout.tsx";

/*
 * Khai báo route bằng code, không dùng file-based: hiện chỉ có vài route, và file-based cần plugin Vite sinh
 * routeTree.gen.ts phải commit và giữ khớp (CI chạy typecheck không qua Vite). Kiểu của route, search, context vẫn
 * được suy ra đầy đủ. Khi số màn tăng (M2 trở đi) có thể chuyển sang file-based mà không đổi code trang.
 */

export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  // Guard đặt ở gốc để cả đường dẫn không tồn tại cũng chuyển về /dang-nhap khi chưa đăng nhập.
  beforeLoad: async ({ context, location }) => {
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
  path: "/dang-nhap",
  validateSearch: validateLoginSearch,
  component: LoginPage,
});

/** Link mời /moi/<mã>: mở được khi chưa đăng nhập (lib/redirect.ts), đứng ngoài khung app như trang đăng nhập. */
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/moi/$token",
  component: InvitePage,
});

/** Trang đồng ý của luồng OAuth cho client MCP; đứng riêng ngoài khung app vì người dùng đến từ CLI. */
const mcpConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dong-y-mcp",
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
  path: "/tao-to-chuc",
  validateSearch: validateOnboardingSearch,
  beforeLoad: async ({ context, search }) => {
    const mine = await context.queryClient.ensureQueryData(orgsMineQuery);
    if (!search.buoc && !mine.canCreateOrg) throw redirect({ to: "/", replace: true });
    if (search.buoc && mine.orgs.length === 0) throw redirect({ to: "/tao-to-chuc", replace: true });
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
    if (mine.orgs.length === 0 && mine.canCreateOrg) throw redirect({ to: "/tao-to-chuc", replace: true });
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

const teamsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/quan-tri/doi",
  validateSearch: validateTeamsSearch,
  component: TeamsPage,
});

const membersRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/quan-tri/thanh-vien",
  validateSearch: validateMembersSearch,
  component: MembersPage,
});

const loginSettingsRoute = createRoute({
  getParentRoute: () => inOrgRoute,
  path: "/quan-tri/dang-nhap",
  component: LoginSettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  mcpConsentRoute,
  sessionRoute.addChildren([
    onboardingRoute,
    appRoute.addChildren([homeRoute, inOrgRoute.addChildren([teamsRoute, membersRoute, loginSettingsRoute])]),
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
