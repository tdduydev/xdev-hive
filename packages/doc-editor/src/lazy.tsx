import { type ComponentProps, lazy, Suspense } from "react";
import { useOptionalDocEditorEnv } from "./env.tsx";
import { docEditorText } from "./text.ts";

/*
 * Tiptap và ProseMirror nặng (~550 kB): tách thành chunk riêng để trang chỉ dùng ReviewPane hay chữ của gói (Tài liệu,
 * Duyệt) không phải tải trình soạn.
 */
const DocEditorImpl = lazy(() => import("./doc-editor.tsx").then((m) => ({ default: m.DocEditor })));
const MarkdownEditorImpl = lazy(() => import("./markdown-editor.tsx").then((m) => ({ default: m.MarkdownEditor })));

function Loading({ lang }: { lang: "vi" | "en" | undefined }) {
  return (
    <div role="status" className="p-6 text-sm text-muted-foreground">
      {docEditorText[lang ?? "vi"].loading}
    </div>
  );
}

export function DocEditor(props: ComponentProps<typeof DocEditorImpl>) {
  const env = useOptionalDocEditorEnv();
  return (
    <Suspense fallback={<Loading lang={env?.lang} />}>
      <DocEditorImpl {...props} />
    </Suspense>
  );
}

export function MarkdownEditor(props: ComponentProps<typeof MarkdownEditorImpl>) {
  return (
    <Suspense fallback={<Loading lang={props.lang} />}>
      <MarkdownEditorImpl {...props} />
    </Suspense>
  );
}
