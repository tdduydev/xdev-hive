import { Link } from "@tanstack/react-router";
import type { DocEditorEnv } from "@xdev-hive/doc-editor";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useLang } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

/** Môi trường của packages/doc-editor trên web: API của tổ chức đang chọn, ngôn ngữ, câu lỗi, liên kết qua router. */
export function useWebDocEnv(): DocEditorEnv {
  const { api } = useOrg();
  const lang = useLang();
  return {
    api,
    lang,
    errorMessage: apiErrorMessage,
    link: ({ to, className, children }) =>
      to.kind === "docs" ? (
        <Link to="/knowledge/docs" className={className}>
          {children}
        </Link>
      ) : to.kind === "doc" ? (
        <Link to="/knowledge/docs/$key/edit" params={{ key: to.key }} className={className}>
          {children}
        </Link>
      ) : (
        <Link to="/runs/$id" params={{ id: to.id }} className={className}>
          {children}
        </Link>
      ),
    sdlc: {
      itemLink: ({ projectKey, number, tab, className, children }) =>
        tab ? (
          <Link
            to="/sdlc/$project/$number/$tab"
            params={{ project: projectKey, number: String(number), tab }}
            className={className}
          >
            {children}
          </Link>
        ) : (
          <Link
            to="/sdlc/$project/$number"
            params={{ project: projectKey, number: String(number) }}
            className={className}
          >
            {children}
          </Link>
        ),
    },
  };
}
