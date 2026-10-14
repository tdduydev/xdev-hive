import type { ContractRouterClient } from "@orpc/contract";
import type { RouterUtils } from "@orpc/tanstack-query";
import type {
  ArtifactDetail,
  ArtifactPageError,
  ArtifactSummary,
  ArtifactTheme,
  ArtifactType,
  Contract,
} from "@xdev-hive/contracts";
import { createContext, type ReactNode, useContext } from "react";
import { type ArtifactsText, artifactsText } from "./text.ts";

export type Lang = "vi" | "en";

/** Một phiên bản artifact mà thẻ trong chat hay tab của khung bên cạnh trỏ tới (`chatMessage.artifact`). */
export interface ArtifactRef {
  id: string;
  version: number;
  title: string;
  type: ArtifactType;
}

/** Trang trong app chủ mà màn artifact liên kết tới; web dựng bằng router, app desktop bằng màn của nó. */
export type ArtifactsLink =
  | { kind: "library" }
  | { kind: "artifact"; id: string; version?: number }
  | { kind: "thread"; id: string }
  | { kind: "run"; id: string };

/** Phiên bản app desktop đã đệm (D17): đọc được khi mất mạng. */
export type CachedArtifact = ArtifactDetail & { cachedAt: string };

/**
 * Bộ đệm offline của app desktop (plan.md "App offline"). Web không có: mất mạng thì báo lỗi tải như mọi màn khác.
 * `put` nhận bản vừa tải được khi có mạng; app tự lấy thêm `frameDocument` nếu loại cần khung.
 */
export interface ArtifactsOfflineCache {
  get: (id: string, version?: number) => Promise<CachedArtifact | null>;
  put: (detail: ArtifactDetail) => void;
  /** URL khung từ bộ đệm (`hive-artifact://frame/<id>/<version>`) thay vé của hub. */
  frameUrl: (id: string, version: number) => string;
}

/** Lời nhờ Leader sửa mà khung bên cạnh gom được; app chủ mở `FixRequestDialog` với dữ liệu này. */
export interface FixRequest {
  artifact: ArtifactSummary;
  version: number;
  errors: ArtifactPageError[];
}

/**
 * Những gì màn artifact cần từ app chủ (D15, như `DocEditorEnv`): web và app desktop dùng chung component, khác nhau ở
 * cách gọi hub (cookie hay token qua Rust), ngôn ngữ, giao diện sáng/tối, origin của khung và khả năng offline.
 */
export interface ArtifactsEnv {
  api: RouterUtils<ContractRouterClient<Contract>>;
  lang: Lang;
  theme: ArtifactTheme;
  errorMessage: (error: unknown) => string;
  link: (props: { to: ArtifactsLink; className?: string; children: ReactNode }) => ReactNode;
  /**
   * Gốc để phân giải URL khung hub trả về (D5). Web: origin của trang; app: địa chỉ hub. Để riêng để sau này đổi sang
   * origin riêng cho khung mà không phải sửa component.
   */
  frameBase: string;
  /** Mất kết nối hub: tắt thao tác ghi, đọc từ `offlineCache` nếu có. */
  offline: boolean;
  offlineCache?: ArtifactsOfflineCache | undefined;
  /** Người xem dùng được Leader ở đây (FR-150); không thì nút "Nhờ Leader sửa" tắt kèm lý do. */
  canAskLeader: boolean;
  onAskLeaderFix?: ((request: FixRequest) => void) | undefined;
  /** Mở hộp Link công khai (chỉ chủ, chính sách bật). */
  onPublicLinks?: ((artifact: ArtifactSummary, version: number) => void) | undefined;
}

const Env = createContext<ArtifactsEnv | null>(null);

export function ArtifactsProvider({ env, children }: { env: ArtifactsEnv; children: ReactNode }) {
  return <Env.Provider value={env}>{children}</Env.Provider>;
}

export function useArtifactsEnv(): ArtifactsEnv {
  const env = useContext(Env);
  if (!env) throw new Error("Màn artifact cần ArtifactsProvider.");
  return env;
}

export function useText(): ArtifactsText {
  return artifactsText[useArtifactsEnv().lang];
}
