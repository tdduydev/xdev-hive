import type { Me } from "@xdev-hive/contracts";
import { createContext, useContext } from "react";

export const MeContext = createContext<Me | null>(null);

/** Người đang đăng nhập, cho mọi trang nằm trong khung app (khung chỉ render khi đã có người dùng). */
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe() chỉ dùng được bên trong khung app.");
  return me;
}
