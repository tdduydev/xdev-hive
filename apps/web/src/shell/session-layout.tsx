import { useSuspenseQuery } from "@tanstack/react-query";
import { Outlet, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { meQuery } from "../lib/me.ts";
import { orgStore, pickOrg } from "../lib/org-store.ts";
import { orgsMineQuery } from "../lib/orgs.ts";
import { orgApi } from "../lib/rpc.ts";
import { MeContext } from "./me-context.ts";
import { OrgsContext, type OrgsState } from "./org-context.ts";

/**
 * Bọc mọi trang sau đăng nhập, kể cả màn tạo tổ chức không có sidebar: người đang đăng nhập, danh sách tổ chức và
 * tổ chức đang làm việc.
 */
export function SessionLayout() {
  const { data: me } = useSuspenseQuery(meQuery);
  const { data: mine } = useSuspenseQuery(orgsMineQuery);
  const storedId = useSyncExternalStore(orgStore.subscribe, orgStore.get);
  const org = pickOrg(mine.orgs, storedId);
  const orgs = useMemo<OrgsState>(
    () => ({ orgs: mine.orgs, canCreateOrg: mine.canCreateOrg, current: org ? { org, api: orgApi(org.id) } : null }),
    [mine, org],
  );
  const router = useRouter();
  // Phiên hết hạn (me tải lại ra null) thì chạy lại guard ở route gốc để về trang đăng nhập.
  useEffect(() => {
    if (!me) void router.invalidate();
  }, [me, router]);
  if (!me) return null;

  return (
    <MeContext value={me}>
      <OrgsContext value={orgs}>
        <Outlet />
      </OrgsContext>
    </MeContext>
  );
}
