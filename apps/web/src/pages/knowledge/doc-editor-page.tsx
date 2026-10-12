import { Link, useParams } from "@tanstack/react-router";
import { DocEditor, type DocEditorEnv, DocEditorProvider } from "@xdev-hive/doc-editor";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { useLang } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

/** Màn soạn tài liệu của web: giao diện ở packages/doc-editor (dùng chung với app desktop), web chỉ nối router và API. */
export function DocEditorPage() {
  const { key } = useParams({ from: "/session/app/in-org/knowledge/docs/$key/edit" });
  const { org, api } = useOrg();
  const lang = useLang();
  const env: DocEditorEnv = {
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
  };
  return (
    <DocEditorProvider env={env}>
      <DocEditor key={`${org.id}:${key}`} docKey={key} />
    </DocEditorProvider>
  );
}
