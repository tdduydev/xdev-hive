import { getDocumentProxy } from "unpdf";
import { ExtractError, type ExtractLimits, type ExtractOutput } from "./types.ts";

export async function extractPdf(bytes: Uint8Array, limits: ExtractLimits): Promise<ExtractOutput> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // PDF.js giữ buffer được truyền vào; truyền bản sao để buffer của luồng không bị tách (detach).
    pdf = await getDocumentProxy(new Uint8Array(bytes), { stopAtErrors: true });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "PasswordException")
      throw new ExtractError("PDF có mật khẩu, không trích được.");
    throw new ExtractError("File PDF hỏng hoặc không đọc được.");
  }
  try {
    const warnings: string[] = [];
    const pages = Math.min(pdf.numPages, limits.pdfPages);
    if (pdf.numPages > pages) warnings.push(`Chỉ trích ${pages}/${pdf.numPages} trang đầu.`);
    const parts: string[] = [];
    for (let n = 1; n <= pages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
      page.cleanup();
      text = text.replace(/[ \t]+\n/g, "\n").trim();
      if (text) parts.push(`## Trang ${n}\n\n${text}`);
    }
    if (!parts.length) throw new ExtractError("Không có chữ để trích (PDF chỉ có ảnh, cần OCR).");
    return { markdown: parts.join("\n\n"), warnings };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
