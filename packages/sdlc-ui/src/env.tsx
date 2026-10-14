import type { ContractRouterClient } from "@orpc/contract";
import type { RouterUtils } from "@orpc/tanstack-query";
import type { Contract } from "@xdev-hive/contracts";
import { createContext, type ReactNode, useContext } from "react";
import { type SdlcText, sdlcText } from "./text.ts";
import type { Lang, SdlcItemTab } from "./types.ts";

export type { Lang, SdlcItemTab } from "./types.ts";

/** Trang trong app chủ mà màn AI SDLC liên kết tới; web dựng bằng router, app desktop bằng hash của màn. */
export type SdlcLink =
  | { kind: "board" }
  | { kind: "new" }
  | { kind: "questions" }
  | { kind: "item"; projectKey: string; number: number; tab?: SdlcItemTab }
  | { kind: "projectSettings"; projectId: string }
  | { kind: "doc"; key: string }
  | { kind: "review"; id: string }
  | { kind: "task"; id: string }
  | { kind: "run"; id: string };

/**
 * Quyền người xem mà app chủ đã biết từ vai trò tổ chức/đội. Hub vẫn kiểm lại mọi thao tác; ở đây chỉ để ẩn nút và hiện
 * "Chỉ đọc" thay vì để người dùng bấm rồi nhận lỗi.
 */
export interface SdlcCan {
  /** `sdlc.write` ở đội của dự án; bỏ `teamId` là "ở ít nhất một đội". */
  write: (teamId?: string) => boolean;
  override: boolean;
  manageModes: boolean;
}

/**
 * Những gì màn AI SDLC cần từ app chủ (plan.md D16, như `DocEditorEnv`): web và app desktop dùng chung component, khác
 * nhau ở cách gọi hub (cookie hay token qua Rust), ngôn ngữ, câu báo lỗi, quyền và cách mở liên kết.
 */
export interface SdlcEnv {
  api: RouterUtils<ContractRouterClient<Contract>>;
  lang: Lang;
  errorMessage: (error: unknown) => string;
  link: (props: { to: SdlcLink; className?: string; children: ReactNode }) => ReactNode;
  can: SdlcCan;
}

const Env = createContext<SdlcEnv | null>(null);

export function SdlcProvider({ env, children }: { env: SdlcEnv; children: ReactNode }) {
  return <Env.Provider value={env}>{children}</Env.Provider>;
}

export function useSdlcEnv(): SdlcEnv {
  const env = useContext(Env);
  if (!env) throw new Error("Màn AI SDLC cần SdlcProvider.");
  return env;
}

export function useText(): SdlcText {
  return sdlcText[useSdlcEnv().lang];
}
