import type { ComponentType } from "react";
import type { ScreenId } from "@/lib/nav.ts";
import { AgentsScreen } from "@/screens/agents-screen.tsx";
import { DelegationTreeScreen } from "@/screens/delegation-tree-screen.tsx";
import { DocsScreen } from "@/screens/docs-screen.tsx";
import { HomeScreen } from "@/screens/home-screen.tsx";
import { MemoryScreen } from "@/screens/memory-screen.tsx";
import { PlansScreen } from "@/screens/plans-screen.tsx";
import { ProjectsScreen } from "@/screens/projects-screen.tsx";
import { RemoteScreen } from "@/screens/remote-screen.tsx";
import { RunsScreen } from "@/screens/runs-screen.tsx";
import { SecretsScreen } from "@/screens/secrets-screen.tsx";
import { SettingsScreen } from "@/screens/settings-screen.tsx";
import { SetupScreen } from "@/screens/setup-screen.tsx";
import { SkillsScreen } from "@/screens/skills-screen.tsx";
import { SshScreen } from "@/screens/ssh-screen.tsx";
import { TokensScreen } from "@/screens/tokens-screen.tsx";
import { WordImportScreen } from "@/screens/word-import-screen.tsx";

/** Màn của cửa sổ app theo mục AppNav; đủ mọi mục nên không còn trang "Sắp có". */
export const SCREENS: Record<ScreenId, ComponentType> = {
  agents: AgentsScreen,
  docs: DocsScreen,
  home: HomeScreen,
  memory: MemoryScreen,
  plans: PlansScreen,
  projects: ProjectsScreen,
  remote: RemoteScreen,
  runs: RunsScreen,
  secrets: SecretsScreen,
  settings: SettingsScreen,
  setup: SetupScreen,
  skills: SkillsScreen,
  ssh: SshScreen,
  tokens: TokensScreen,
  tree: DelegationTreeScreen,
  "word-import": WordImportScreen,
};

/**
 * Màn tự chia cả vùng nội dung thành cột (Tài liệu từ code: thư mục, trình soạn, chat):
 * khung không thêm lề, không cuộn chung, và AppNav thu về cột icon như bản `compact` của thiết kế để còn chỗ.
 */
export const FULL_BLEED: ReadonlySet<ScreenId> = new Set<ScreenId>(["docs"]);
