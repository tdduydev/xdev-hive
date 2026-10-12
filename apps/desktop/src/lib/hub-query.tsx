import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import type { DocEditorEnv } from "@xdev-hive/doc-editor";
import { hub } from "@/lib/hub-rpc.ts";
import { useLang } from "@/lib/i18n.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

/** Một client cho mọi màn gọi hub: dữ liệu giữ lại khi chuyển màn hay giữa danh sách và chi tiết. */
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
export const api = createTanstackQueryUtils(hub);

/**
 * Môi trường của packages/doc-editor trong app: client hub qua token cá nhân (hub-rpc), câu báo lỗi, liên kết. Tài liệu
 * mở ở màn Soạn tài liệu; run là trang của hub nên mở trong cửa sổ web của hub, đúng một trang người dùng bấm.
 */
export function useDesktopDocEnv(): DocEditorEnv {
  const lang = useLang();
  return {
    api,
    lang,
    errorMessage: errorText,
    link: ({ to, className, children }) => (
      <button
        type="button"
        className={`cursor-pointer border-0 bg-transparent p-0 text-left ${className ?? ""}`}
        onClick={() => {
          if (to.kind === "docs") location.hash = "#/write";
          else if (to.kind === "doc") location.hash = `#/write/${encodeURIComponent(to.key)}`;
          else void invoke("open_hub_page", { path: `/runs/${to.id}` });
        }}
      >
        {children}
      </button>
    ),
  };
}
