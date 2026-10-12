import type { ComponentType } from "react";
import type { ScreenId } from "@/lib/nav.ts";
import { HomeScreen } from "@/screens/home-screen.tsx";
import { SetupScreen } from "@/screens/setup-screen.tsx";
import { TokensScreen } from "@/screens/tokens-screen.tsx";

/**
 * Màn đã làm của cửa sổ app, theo mục AppNav. Mục chưa có ở đây hiện trang "Sắp có". Mỗi task trong
 * specs/008-desktop-v2/tasks.md thêm đúng một dòng cho màn của nó để các task chạy song song ít đụng nhau.
 */
export const SCREENS: Partial<Record<ScreenId, ComponentType>> = {
  home: HomeScreen,
  setup: SetupScreen,
  tokens: TokensScreen,
};
