import { docAssetGetInput } from "@xdev-hive/contracts";
import { z } from "zod";
import { knowledgePrincipal, MCP_LIMITS } from "../knowledge/index.ts";
import type { McpToolRegistry } from "../mcp/index.ts";
import { NotFoundError } from "../platform/index.ts";
import { findDocAsset } from "./assets.ts";
import { approvedExtractOf } from "./extracts.ts";

/** Tool đọc file đính kèm cho agent. Cổng MCP đã chọn tổ chức, mở withTenant và sẽ ghi audit. */
export function registerMcpTools(registry: McpToolRegistry): void {
  registry.register({
    name: "doc_asset_get",
    title: "Đọc file đính kèm",
    description: "Đọc bản trích đã duyệt (Markdown) của file .docx, .pdf, .xlsx, .csv, .pptx mà tài liệu link tới.",
    input: docAssetGetInput.extend({
      docKey: docAssetGetInput.shape.docKey.describe("Key tài liệu có link tới file."),
      path: docAssetGetInput.shape.path.describe("Đường dẫn trong link, tương đối với tài liệu."),
      offset: z.number().int().min(0).optional().describe("Vị trí đọc tiếp từ nextOffset."),
    }),
    readOnly: true,
    handler: async ({ docKey, path, offset }, { tx, principal }) => {
      // findDocAsset kiểm quyền đọc tài liệu và link; agent chỉ thấy file của tài liệu nó đọc được.
      const asset = await findDocAsset(tx, await knowledgePrincipal(tx, principal), { docKey, path });
      const extract = await approvedExtractOf(tx, asset.id);
      if (!extract) throw new NotFoundError("DOCSYNC_EXTRACT_NOT_APPROVED", "File chưa có bản trích đã duyệt để đọc.");
      const start = offset ?? 0;
      const content = extract.content.slice(start, start + MCP_LIMITS.pageChars);
      const end = start + content.length;
      return {
        repoPath: asset.repoPath,
        mediaType: asset.mediaType,
        sha256: extract.sourceSha256,
        stale: extract.sourceSha256 !== asset.sha256,
        content,
        offset: start,
        totalChars: extract.content.length,
        nextOffset: end < extract.content.length ? end : null,
      };
    },
  });
}
