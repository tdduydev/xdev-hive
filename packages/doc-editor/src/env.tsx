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

export function useText() {
  return docEditorText[useDocEditorEnv().lang];
}
