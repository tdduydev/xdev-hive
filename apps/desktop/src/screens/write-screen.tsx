import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { docKey as docKeySchema } from "@xdev-hive/contracts";
import { DocEditor, DocEditorProvider } from "@xdev-hive/doc-editor";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { type FormEvent, useId, useState, useSyncExternalStore } from "react";
import { api, queryClient, useDesktopDocEnv } from "@/lib/hub-query.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { screenParam } from "@/lib/nav.ts";
import { errorText } from "@/lib/tauri.ts";

const text: Dict<{
  lead: string;
  empty: string;
  newDoc: string;
  key: string;
  hint: string;
  open: string;
  loading: string;
}> = {
  vi: {
    lead: "Soạn PRD, spec, ADR với cả đội: bản nháp chung, đề xuất sửa, bình luận, AI chạy trên máy của bạn.",
    empty: "Chưa có tài liệu nào bạn đọc được.",
    newDoc: "Tài liệu mới",
    key: "Key tài liệu",
    hint: "Dạng project/<dự án>/<tên>, team/<đội>/<tên> hoặc org/<tên>.",
    open: "Mở trình soạn",
    loading: "Đang tải…",
  },
  en: {
    lead: "Write PRDs, specs and ADRs with your team: shared draft, suggestions, comments, AI on your machine.",
    empty: "No docs you can read yet.",
    newDoc: "New doc",
    key: "Doc key",
    hint: "Like project/<project>/<name>, team/<team>/<name> or org/<name>.",
    open: "Open editor",
    loading: "Loading…",
  },
};

const go = (key?: string) => {
  location.hash = key ? `#/write/${encodeURIComponent(key)}` : "#/write";
};

function subscribe(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/**
 * Màn Soạn tài liệu của app (spec 008 US9): giao diện ở packages/doc-editor, dùng chung với web; app đưa vào client
 * hub qua token cá nhân (hub-rpc), câu báo lỗi và cách mở liên kết. `#/write` là danh sách, `#/write/<key>` là trình soạn.
 */
export function WriteScreen() {
  const docKey = useSyncExternalStore(subscribe, () => screenParam(location.hash));
  return (
    <QueryClientProvider client={queryClient}>
      <DocEditorProvider env={useDesktopDocEnv()}>
        {docKey ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
            <DocEditor key={docKey} docKey={docKey} />
          </div>
        ) : (
          <DocPicker />
        )}
      </DocEditorProvider>
    </QueryClientProvider>
  );
}

function DocPicker() {
  const t = useT(text);
  const fieldId = useId();
  const docs = useQuery(api.docs.list.queryOptions({ input: {} }));
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = docKeySchema.safeParse(key.trim());
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? t.hint);
    go(parsed.data);
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-5">
      <p className="text-muted-foreground">{t.lead}</p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
          <label htmlFor={fieldId} className="font-medium">
            {t.newDoc}
          </label>
          <Input
            id={fieldId}
            className="font-mono"
            placeholder="project/payment-api/prd-refund"
            value={key}
            aria-invalid={!!error}
            aria-describedby={`${fieldId}-hint`}
            onChange={(e) => {
              setKey(e.currentTarget.value);
              setError(null);
            }}
          />
          <span id={`${fieldId}-hint`} className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {error ?? t.hint}
          </span>
        </div>
        <Button type="submit">{t.open}</Button>
      </form>
      {docs.isPending && (
        <p role="status" className="text-muted-foreground">
          {t.loading}
        </p>
      )}
      {docs.error && <Alert variant="destructive">{errorText(docs.error)}</Alert>}
      {docs.data && !docs.data.length && <p className="text-muted-foreground">{t.empty}</p>}
      {docs.data && docs.data.length > 0 && (
        <ul className="m-0 flex list-none flex-col divide-y rounded-lg border p-0">
          {docs.data.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => go(d.key)}
                className="flex w-full cursor-pointer flex-col items-start gap-0.5 border-0 bg-transparent px-4 py-3 text-left hover:bg-muted"
              >
                <strong className="font-medium">{d.title}</strong>
                <span className="font-mono text-xs text-muted-foreground">
                  {d.key} · v{d.version}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
