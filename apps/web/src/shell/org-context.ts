import type { MyOrg } from "@xdev-hive/contracts";
import { createContext, useContext } from "react";
import type { OrgApi } from "@/lib/rpc.ts";

export interface CurrentOrg {
  org: MyOrg;
  /** API gắn sẵn header x-hive-org của tổ chức này. */
  api: OrgApi;
}

export interface OrgsState {
  orgs: MyOrg[];
  canCreateOrg: boolean;
  /** null khi chưa thuộc tổ chức nào. */
  current: CurrentOrg | null;
}

export const OrgsContext = createContext<OrgsState | null>(null);

export function useOrgs(): OrgsState {
  const state = useContext(OrgsContext);
  if (!state) throw new Error("useOrgs() chỉ dùng được bên trong SessionLayout.");
  return state;
}

/** Tổ chức đang làm việc, cho các trang chỉ mở được khi đã thuộc một tổ chức (route chặn trước). */
export function useOrg(): CurrentOrg {
  const { current } = useOrgs();
  if (!current) throw new Error("useOrg() cần người dùng đã thuộc một tổ chức.");
  return current;
}
