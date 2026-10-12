import { useParams } from "@tanstack/react-router";
import { DocEditor, DocEditorProvider } from "@xdev-hive/doc-editor";
import { useWebDocEnv } from "@/lib/doc-editor-env.tsx";
import { useOrg } from "@/shell/org-context.ts";

/** Màn soạn tài liệu của web: giao diện ở packages/doc-editor (dùng chung với app desktop), web chỉ nối router và API. */
export function DocEditorPage() {
  const { key } = useParams({ from: "/session/app/in-org/knowledge/docs/$key/edit" });
  const { org } = useOrg();
  return (
    <DocEditorProvider env={useWebDocEnv()}>
      <DocEditor key={`${org.id}:${key}`} docKey={key} />
    </DocEditorProvider>
  );
}
