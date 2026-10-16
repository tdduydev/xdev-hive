import type { ComponentType } from "react";
import type { ScreenId } from "@/lib/nav.ts";
import { DocsScreen } from "@/screens/docs-screen.tsx";
import { HomeScreen } from "@/screens/home-screen.tsx";
import { MemoryScreen } from "@/screens/memory-screen.tsx";
import { PlansScreen } from "@/screens/plans-screen.tsx";
import { ProjectsScreen } from "@/screens/projects-screen.tsx";
import { RemoteScreen } from "@/screens/remote-screen.tsx";
import { RunsScreen } from "@/screens/runs-screen.tsx";
import { SettingsScreen } from "@/screens/settings-screen.tsx";
import { SetupScreen } from "@/screens/setup-screen.tsx";
import { SkillsScreen } from "@/screens/skills-screen.tsx";
import { TokensScreen } from "@/screens/tokens-screen.tsx";

/** Màn của cửa sổ app theo mục AppNav; đủ mọi mục nên không còn trang "Sắp có". */
export const SCREENS: Record<ScreenId, ComponentType> = {
  docs: DocsScreen,
  home: HomeScreen,
  memory: MemoryScreen,
  plans: PlansScreen,
  projects: ProjectsScreen,
  remote: RemoteScreen,
  runs: RunsScreen,
  settings: SettingsScreen,
  setup: SetupScreen,
  skills: SkillsScreen,
  tokens: TokensScreen,
};

/**
 * Màn tự chia cả vùng nội dung thành cột (Tài liệu từ code: thư mục, trình soạn, chat): khung không thêm lề, không cuộn
 * chung, và AppNav thu về cột icon như bản `compact` của thiết kế để còn chỗ cho trình soạn.
 */
export const FULL_BLEED: ReadonlySet<ScreenId> = new Set<ScreenId>(["docs"]);
