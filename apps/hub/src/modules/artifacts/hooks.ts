import type { ArtifactLinkKind, ArtifactPageError } from "@xdev-hive/contracts";
import type { Tx } from "../platform/index.ts";
import type { Reader } from "./access.ts";

/*
 * Điểm nối cho module khác (plan.md D10, D11, D19, D23). `artifacts` không import `leader`, `runs`, `tasks`… (vòng phụ
 * thuộc, `pnpm deps` chặn); các module đó cài hook tại main.ts như `provide*` của mcp/registry.ts.
 */

/** Cuộc trò chuyện Leader (module `leader` cài, T013/T016). */
export interface ThreadHost {
  /**
   * FR-033: `threadId` là cuộc trò chuyện của run `leader` đang gọi (cùng kiểm của `leader_reply`). Sai thì ném
   * `ARTIFACT_LINK_FORBIDDEN`. Trả dự án của cuộc trò chuyện và người mở nó (chủ của artifact `private`).
   */
  assertRunThread(tx: Tx, runId: string, threadId: string): Promise<{ projectId: string | null; userId: string }>;
  /** Thêm tin nhắn thẻ (role `leader`, `content` là tiêu đề cho client cũ) vào cuộc trò chuyện. */
  postArtifactCard(
    tx: Tx,
    input: { threadId: string; artifactId: string; version: number; title: string; runId: string | null },
  ): Promise<void>;
  /** "Nhờ Leader sửa" (D23): kiểm/tạo cuộc trò chuyện của người gọi, thêm tin có `page_errors`, khởi động run `leader`. */
  postFixRequest(
    tx: Tx,
    input: {
      userId: string;
      threadId: string | null;
      projectId: string | null;
      artifactId: string;
      version: number;
      title: string;
      errors: ArtifactPageError[];
      note: string | null;
      canWrite: boolean;
    },
  ): Promise<{ threadId: string; messageId: string; runId: string | null }>;
}

/** Phiên Terminal Leader (LEADTERM cài, US8). */
export interface TerminalHost {
  /** `sessionId` thuộc `userId`; sai thì ném `ARTIFACT_LINK_FORBIDDEN`. */
  assertOwner(tx: Tx, sessionId: string, userId: string): Promise<void>;
}

/** Đích gắn artifact (task, run, hạng mục, tài liệu…); module sở hữu đích tự quyết quyền trên đích của nó (D11). */
export interface LinkTarget {
  kind: ArtifactLinkKind;
  /** Người gọi sửa được đích; không thì ném lỗi (thường `ARTIFACT_LINK_FORBIDDEN` hoặc NOT_FOUND của đích). */
  assertWritable(tx: Tx, reader: Reader, targetId: string): Promise<void>;
  /** Dự án của đích, để đòi artifact có phạm vi đủ rộng (US10-1). null: đích không thuộc dự án nào. */
  projectOf(tx: Tx, targetId: string): Promise<string | null>;
  /** Tên hiện ở danh sách liên kết, chỉ cho đích người xem đọc được. */
  titles?(tx: Tx, reader: Reader, targetIds: string[]): Promise<Map<string, string>>;
  /** Đích còn tồn tại; job dọn xoá liên kết tới đích đã mất. Không cài thì liên kết của loại đó không bị dọn. */
  existing?(tx: Tx, targetIds: string[]): Promise<Set<string>>;
}

/**
 * Tạo đề xuất tài liệu (module `knowledge` cài, specs/012 T066). `artifacts` không import `knowledge` vì
 * `knowledge/artifact-link.ts` đã import `artifacts`; lỗi quyền, xung đột bản và bí mật do `knowledge` ném, giữ nguyên.
 */
export interface DocProposer {
  /** Đề xuất `content` làm bản mới của tài liệu `key` (tạo mới nếu chưa có), thay mặt `userId`. */
  propose(
    tx: Tx,
    input: { userId: string; key: string; title: string | undefined; content: string; reason: string },
  ): Promise<{ proposalId: string }>;
}

let threadHost: ThreadHost | undefined;
let terminalHost: TerminalHost | undefined;
let docProposer: DocProposer | undefined;
const linkTargets = new Map<ArtifactLinkKind, LinkTarget>();

export function provideThreadHost(host: ThreadHost | undefined): void {
  threadHost = host;
}

export function provideTerminalHost(host: TerminalHost | undefined): void {
  terminalHost = host;
}

export function provideDocProposer(proposer: DocProposer | undefined): void {
  docProposer = proposer;
}

/** Cài (hoặc gỡ khi `target` undefined) đích của một loại. */
export function provideLinkTarget(kind: ArtifactLinkKind, target: LinkTarget | undefined): void {
  if (target) linkTargets.set(kind, target);
  else linkTargets.delete(kind);
}

export const threadHostOf = () => threadHost;
export const terminalHostOf = () => terminalHost;
export const docProposerOf = () => docProposer;
export const linkTargetOf = (kind: ArtifactLinkKind) => linkTargets.get(kind);
export const allLinkTargets = () => [...linkTargets.values()];
