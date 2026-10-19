import type { Auth } from "../../identity/index.ts";
import type { BlobStore, HubConfig } from "../../platform/index.ts";
import type { DocSyncDeps } from "../routes/deps.ts";
import type { docWordImportFiles, docWordImports } from "../schema.ts";
import { detectPandoc, type PandocCheck, type PandocCommand } from "./pandoc.ts";
import { detectSoffice, type SofficeCheck } from "./soffice.ts";

export type WordImportConfig = NonNullable<HubConfig["wordImport"]>;
export type WordImportRow = typeof docWordImports.$inferSelect;
export type WordImportFileRow = typeof docWordImportFiles.$inferSelect;

/** Deps của các route HTTP nhập Word (multipart, ảnh xem trước, file gốc), như `AssetDeps` của đính kèm. */
export type WordHttpDeps = DocSyncDeps & {
  /** Đã bọc `withPersonalTokens` ở app.ts: app desktop gửi bằng token cá nhân (Q12). */
  auth?: Auth | undefined;
  blobStore?: BlobStore | undefined;
};

export interface WordTools {
  config: WordImportConfig;
  pandoc: PandocCheck;
  soffice: SofficeCheck;
}

export interface WordToolDetectors {
  pandoc?: (path: PandocCommand) => Promise<PandocCheck>;
  soffice?: (path: string) => Promise<SofficeCheck>;
}

// Dò một lần lúc khởi động (plan.md mục 12): health, route nhận file và job đều đọc cùng kết quả mà không chạy lại
// `--version` mỗi request. Chưa dò thì coi như tắt, để hub thiếu công cụ không nhận file rồi chuyển hỏng.
let current: WordTools | null = null;

export async function detectWordTools(config: WordImportConfig, detectors: WordToolDetectors = {}): Promise<WordTools> {
  const [pandoc, soffice] = await Promise.all([
    (detectors.pandoc ?? detectPandoc)(config.pandocPath),
    (detectors.soffice ?? detectSoffice)(config.sofficePath),
  ]);
  current = { config, pandoc, soffice };
  return current;
}

export function wordTools(): WordTools | null {
  return current;
}

/** Test đặt sẵn kết quả dò, không cần pandoc thật. */
export function provideWordTools(tools: WordTools | null): void {
  current = tools;
}

/** Trường của `/api/v1/health` (FR-023). `.doc` cần cả LibreOffice lẫn pandoc. */
export function wordImportHealth(): { wordImport: boolean; wordImportDoc: boolean } {
  const pandoc = current?.pandoc.ok ?? false;
  return { wordImport: pandoc, wordImportDoc: pandoc && (current?.soffice.ok ?? false) };
}

/** Route HTTP chưa làm: trả 501 cùng dạng lỗi với các route Hono khác của docsync. */
export function notImplementedResponse(): Response {
  return Response.json(
    { defined: false, code: "NOT_IMPLEMENTED", status: 501, message: "Nhập Word chưa được triển khai." },
    { status: 501 },
  );
}
