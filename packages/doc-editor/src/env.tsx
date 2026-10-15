import type { ContractRouterClient } from "@orpc/contract";
import type { RouterUtils } from "@orpc/tanstack-query";
import type { Contract } from "@xdev-hive/contracts";
import { createContext, type ReactNode, useContext } from "react";
import { docEditorText } from "./text.ts";

export type Lang = "vi" | "en";
export type Dict<T> = Record<Lang, T>;

/** Trang trong app chủ mà trình soạn liên kết tới; mỗi app tự dựng đường dẫn (web: router, app: cửa sổ hub). */
export type DocEditorLink = { kind: "docs" } | { kind: "doc"; key: string } | { kind: "run"; id: string };

/**
 * Những gì trình soạn cần từ app chủ (spec 008 FR-027): web và app desktop dùng chung một giao diện, khác nhau ở cách
 * gọi hub (cookie hay token cá nhân qua Rust), ngôn ngữ, câu báo lỗi và cách mở liên kết.
 */
export interface DocEditorEnv {
  api: RouterUtils<ContractRouterClient<Contract>>;
  lang: Lang;
  errorMessage: (error: unknown) => string;
  link: (props: { to: DocEditorLink; className?: string; children: ReactNode }) => ReactNode;
  /**
   * Bật khung bên "Hạng mục" cho tài liệu `project/<k>/sdlc/…` (specs/011 T053). Tách khỏi `DocEditorLink` để app chủ
   * chưa có màn AI SDLC không phải xử lý liên kết tới hạng mục; bỏ trống thì tài liệu mở như mọi tài liệu khác.
   */
  sdlc?: DocEditorSdlc;
  /**
   * Phân giải link và ảnh tương đối của tài liệu `docKey` (FR-025). App chủ nên gom cả tài liệu vào một lời gọi hub
   * (`docAssets.resolve`) rồi trả từ bộ nhớ đệm; trình soạn gọi cho từng link/ảnh. Bỏ trống thì ảnh tương đối hiện
   * chỗ giữ chỗ và bấm link tương đối không mở gì.
   */
  resolveLink?: (docKey: string, href: string) => DocLinkTarget | null | Promise<DocLinkTarget | null>;
  /**
   * Tải file lên kho file của tài liệu (FR-030). Trả đường dẫn tương đối so với tài liệu để chèn vào Markdown. Bỏ trống
   * thì nút "Chèn ảnh", "Đính kèm file", dán và kéo thả file đều tắt.
   */
  uploadAsset?: (docKey: string, file: File) => Promise<{ relativePath: string }>;
}

/** Đích của một link tương đối: tài liệu hub, file trong kho file, hoặc link ngoài (file trên GitHub/GitLab). */
export type DocLinkTarget =
  | { kind: "doc"; key: string }
  | { kind: "asset"; url: string }
  | { kind: "external"; url: string };

export interface DocEditorSdlc {
  /** Mở hạng mục (`tab` như `SdlcItemTab` của `@xdev-hive/sdlc-ui`). */
  itemLink: (props: {
    projectKey: string;
    number: number;
    tab?: "tasks" | "questions";
    className?: string;
    children: ReactNode;
  }) => ReactNode;
}

const Env = createContext<DocEditorEnv | null>(null);

export function DocEditorProvider({ env, children }: { env: DocEditorEnv; children: ReactNode }) {
  return <Env.Provider value={env}>{children}</Env.Provider>;
}

export function useDocEditorEnv(): DocEditorEnv {
  const env = useContext(Env);
  if (!env) throw new Error("DocEditor cần DocEditorProvider.");
  return env;
}

/** Cho phần dùng được cả ngoài DocEditorProvider (MarkdownEditor trong app desktop soạn file trên máy). */
export function useOptionalDocEditorEnv(): DocEditorEnv | null {
  return useContext(Env);
}

export function useText() {
  return docEditorText[useDocEditorEnv().lang];
}
