import type { ComponentType } from "react";
import type { ScreenId } from "@/lib/nav.ts";
import { DocsScreen } from "@/screens/docs-screen.tsx";
import { HomeScreen } from "@/screens/home-screen.tsx";
import { SetupScreen } from "@/screens/setup-screen.tsx";
import { SkillsScreen } from "@/screens/skills-screen.tsx";
import { TokensScreen } from "@/screens/tokens-screen.tsx";

/**
 * Màn đã làm của cửa sổ app, theo mục AppNav. Mục chưa có ở đây hiện trang "Sắp có". Mỗi task trong
 * specs/008-desktop-v2/tasks.md thêm đúng một dòng cho màn của nó để các task chạy song song ít đụng nhau.
 */
export const SCREENS: Partial<Record<ScreenId, ComponentType>> = {
  docs: DocsScreen,
  home: HomeScreen,
  setup: SetupScreen,
  skills: SkillsScreen,
  tokens: TokensScreen,
};

/**
 * Màn tự chia cả vùng nội dung thành cột (Tài liệu: thư mục, trình soạn, chat): khung không thêm lề, không cuộn chung,
 * và AppNav thu về cột icon như bản `compact` của thiết kế để còn chỗ cho trình soạn.
 */
export const FULL_BLEED: ReadonlySet<ScreenId> = new Set<ScreenId>(["docs"]);
