import mammoth from "mammoth";
import TurndownService from "turndown";
import type { ExtractLimits, ExtractOutput } from "./types.ts";
import { readZip, repack } from "./zip.ts";

export async function extractDocx(bytes: Uint8Array, limits: ExtractLimits): Promise<ExtractOutput> {
  const buffer = await repack(await readZip(bytes, limits));
  // Ảnh nhúng thành data URI dài hàng MB, vô ích cho tìm kiếm; giữ chỗ bằng alt.
  const { value, messages } = await mammoth.convertToHtml(
    { buffer },
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  );
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  turndown.addRule("emptyImage", {
    filter: "img",
    replacement: (_, node) => `[Hình: ${node.getAttribute("alt") || "ảnh"}]`,
  });
  const warnings = [...new Set(messages.filter((m) => m.type === "warning").map((m) => m.message))].slice(0, 20);
  return { markdown: turndown.turndown(value).trim(), warnings };
}
