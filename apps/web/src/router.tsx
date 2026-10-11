import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { meQuery } from "./lib/me.ts";
import { authRedirect } from "./lib/redirect.ts";
import { HomePage } from "./pages/home-page.tsx";
import { LoginPage, validateLoginSearch } from "./pages/login-page.tsx";
import { McpConsentPage } from "./pages/mcp-consent-page.tsx";
import { LoadErrorPage, NotFoundPage, PendingPage } from "./pages/status-pages.tsx";
import { AppShell } from "./shell/app-shell.tsx";

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

/** Trang đồng ý của luồng OAuth cho client MCP; đứng riêng ngoài khung app vì người dùng đến từ CLI. */
const mcpConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/dong-y-mcp",
  component: McpConsentPage,
});

/** Layout không có path: mọi trang cần đăng nhập nằm trong khung app. */
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: "app", component: AppShell });

const homeRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomePage });

const routeTree = rootRoute.addChildren([loginRoute, mcpConsentRoute, appRoute.addChildren([homeRoute])]);

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
