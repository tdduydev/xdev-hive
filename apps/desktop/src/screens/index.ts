import type { ComponentType } from "react";
import type { ScreenId } from "@/lib/nav.ts";
import { DocsScreen } from "@/screens/docs-screen.tsx";
import { HomeScreen } from "@/screens/home-screen.tsx";
import { KnowledgeScreen } from "@/screens/knowledge-screen.tsx";
import { ReviewsScreen } from "@/screens/reviews-screen.tsx";
import { RunsScreen } from "@/screens/runs-screen.tsx";
import { SetupScreen } from "@/screens/setup-screen.tsx";
import { SkillsScreen } from "@/screens/skills-screen.tsx";
import { TokensScreen } from "@/screens/tokens-screen.tsx";
import { WorkScreen } from "@/screens/work-screen.tsx";
import { WriteScreen } from "@/screens/write-screen.tsx";

/** Màn của cửa sổ app theo mục AppNav; đủ mọi mục nên không còn trang "Sắp có". */
export const SCREENS: Record<ScreenId, ComponentType> = {
  docs: DocsScreen,
  home: HomeScreen,
  knowledge: KnowledgeScreen,
  reviews: ReviewsScreen,
  runs: RunsScreen,
  setup: SetupScreen,
  skills: SkillsScreen,
  tokens: TokensScreen,
  work: WorkScreen,
  write: WriteScreen,
};

/**
 * Màn tự chia cả vùng nội dung thành cột (Tài liệu: thư mục, trình soạn, chat): khung không thêm lề, không cuộn chung,
 * và AppNav thu về cột icon như bản `compact` của thiết kế để còn chỗ cho trình soạn.
 */
export const FULL_BLEED: ReadonlySet<ScreenId> = new Set<ScreenId>(["docs", "write"]);
