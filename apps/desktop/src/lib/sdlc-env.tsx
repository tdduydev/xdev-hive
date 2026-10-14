import type { SdlcEnv, SdlcItemTab, SdlcLink } from "@xdev-hive/sdlc-ui";
import { useLinkedAccount } from "@/lib/account.ts";
import { api } from "@/lib/hub-query.tsx";
import { useLang } from "@/lib/i18n.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

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
export const sdlcTabOf = (value: string | undefined): SdlcItemTab =>
  SDLC_TABS.find((tab) => tab === value) ?? "overview";
export const itemHash = (projectKey: string, number: number, tab?: string) =>
  `#/sdlc/${encodeURIComponent(projectKey)}/${number}${tab && tab !== "overview" ? `/${tab}` : ""}`;

/** `#/sdlc/loc?project=…&mode=…`: tham số sau `loc` là bộ lọc mở sẵn, không phải key dự án (key không có `?`). */
export function boardHash(projectId?: string, modeRef?: string): string {
  const query = new URLSearchParams({
    ...(projectId ? { project: projectId } : {}),
    ...(modeRef ? { mode: modeRef } : {}),
  });
  return query.size ? `#/sdlc/loc?${query}` : "#/sdlc";
}

/** Đọc bộ lọc từ tham số màn Hạng mục; không phải dạng `loc?…` thì null. */
export function boardFilterOf(param: string): { projectId?: string; modeRef?: string } | null {
  if (!param.startsWith("loc?")) return null;
  const query = new URLSearchParams(param.slice(4));
  const projectId = query.get("project");
  const modeRef = query.get("mode");
  return { ...(projectId ? { projectId } : {}), ...(modeRef ? { modeRef } : {}) };
}

function hashOf(to: SdlcLink): string | null {
  switch (to.kind) {
    case "board":
      return boardHash(to.projectId, to.modeRef);
    case "new":
      return "#/sdlc/new";
    case "questions":
      return "#/sdlc-questions";
    case "item":
      return itemHash(to.projectKey, to.number, to.tab);
    case "doc":
      return `#/write/${encodeURIComponent(to.key)}`;
    case "review":
      return `#/reviews/${encodeURIComponent(to.id)}`;
    default:
      return null;
  }
}

/** Vai trò BA/PO có quyền AI SDLC riêng; hồ sơ menu writer không làm mất quyền ghi của đội đó. */
export function useDesktopSdlcEnv(): SdlcEnv {
  const account = useLinkedAccount();
  const lang = useLang();
  const admin = account?.orgRole === "owner" || account?.orgRole === "admin";
  const write = (teamId?: string) =>
    !!admin || !!account?.teams.some((team) => (!teamId || team.id === teamId) && team.role !== "viewer");
  return {
    api,
    lang,
    errorMessage: errorText,
    can: {
      write,
      override: !!admin || !!account?.teams.some((team) => team.role === "admin"),
      manageModes: !!admin || !!account?.teams.some((team) => team.role === "admin"),
    },
    link: ({ to, className, children }) => {
      const hash = hashOf(to);
      if (hash)
        return (
          <a href={hash} className={className}>
            {children}
          </a>
        );
      const path = to.kind === "run" ? `/runs/${to.id}` : to.kind === "projectSettings" ? "/projects" : "/tasks";
      return (
        <button
          type="button"
          className={`cursor-pointer text-left ${className ?? ""}`}
          onClick={() => void invoke("open_hub_page", { path })}
        >
          {children}
        </button>
      );
    },
  };
}
