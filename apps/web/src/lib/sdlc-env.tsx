import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { SdlcEnv, SdlcItemTab, SdlcLink } from "@xdev-hive/sdlc-ui";
import type { ReactNode } from "react";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useLang } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { useOrg } from "@/shell/org-context.ts";

/** Đoạn đường dẫn của tab chi tiết; tab Tổng quan là đường dẫn gốc của hạng mục. */
export const SDLC_TABS: readonly SdlcItemTab[] = [
  "overview",
  "projects",
  "docs",
  "contracts",
  "questions",
  "tasks",
  "trace",
  "converge",
];

export function sdlcTabOf(value: string | undefined): SdlcItemTab {
  return SDLC_TABS.find((t) => t === value) ?? "overview";
}

function SdlcAnchor({ to, className, children }: { to: SdlcLink; className?: string; children: ReactNode }) {
  const { api } = useOrg();
  // Liên kết tới cài đặt dự án chỉ có mã dự án; route web đi theo key nên tra trong danh sách dự án đã tải.
  const projects = useQuery({
    ...api.projects.list.queryOptions({ input: {} }),
    enabled: to.kind === "projectSettings",
  });
  switch (to.kind) {
    case "board":
      return (
        <Link to="/sdlc" className={className}>
          {children}
        </Link>
      );
    case "new":
      return (
        <Link to="/sdlc/new" className={className}>
          {children}
        </Link>
      );
    case "questions":
      return (
        <Link to="/sdlc/questions" className={className}>
          {children}
        </Link>
      );
    case "item":
      return !to.tab || to.tab === "overview" ? (
        <Link
          to="/sdlc/$project/$number"
          params={{ project: to.projectKey, number: String(to.number) }}
          className={className}
        >
          {children}
        </Link>
      ) : (
        <Link
          to="/sdlc/$project/$number/$tab"
          params={{ project: to.projectKey, number: String(to.number), tab: to.tab }}
          className={className}
        >
          {children}
        </Link>
      );
    case "projectSettings": {
      const key = projects.data?.find((p) => p.id === to.projectId)?.key;
      return key ? (
        <Link to="/projects/$key/settings" params={{ key }} className={className}>
          {children}
        </Link>
      ) : (
        <Link to="/projects" className={className}>
          {children}
        </Link>
      );
    }
    case "doc":
      return (
        <Link to="/knowledge/docs/$key/edit" params={{ key: to.key }} className={className}>
          {children}
        </Link>
      );
    case "review":
      return (
        <Link to="/knowledge/reviews" search={{ id: to.id }} className={className}>
          {children}
        </Link>
      );
    case "task":
      // Web chưa có trang một task theo mã; bảng việc là nơi gần nhất.
      return (
        <Link to="/tasks" className={className}>
          {children}
        </Link>
      );
    case "run":
      return (
        <Link to="/runs/$id" params={{ id: to.id }} className={className}>
          {children}
        </Link>
      );
  }
}

/**
 * Môi trường của packages/sdlc-ui trên web: API của tổ chức đang chọn, ngôn ngữ, câu lỗi, quyền theo vai trò, liên kết
 * qua router. Quyền theo đội chưa có trên web nên `write(teamId)` dùng quyền của tổ chức; hub vẫn kiểm theo đội.
 */
export function useWebSdlcEnv(): SdlcEnv {
  const { api } = useOrg();
  const lang = useLang();
  const can = usePermissions();
  return {
    api,
    lang,
    errorMessage: apiErrorMessage,
    link: (props) => <SdlcAnchor {...props} />,
    can: {
      write: () => can("sdlc.write"),
      override: can("sdlc.override"),
      manageModes: can("sdlc.modes.write"),
    },
  };
}
