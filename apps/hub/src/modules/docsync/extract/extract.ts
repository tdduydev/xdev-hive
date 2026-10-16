import { ExtractError, type ExtractKind, type ExtractLimits, type ExtractOutput } from "./types.ts";

const KINDS: Record<string, ExtractKind> = { docx: "docx", pdf: "pdf", xlsx: "xlsx", csv: "csv", pptx: "pptx" };

export function extractKind(path: string): ExtractKind | null {
  return KINDS[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? null;
}

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b);

/** Kiểm magic bytes, không tin đuôi file (research.md mục 3.5): file đổi đuôi không được đi vào parser sai loại. */
export function checkMagic(kind: ExtractKind, bytes: Uint8Array): void {
  const ok =
    kind === "pdf"
      ? startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
      : kind === "csv"
        ? !bytes.subarray(0, 8192).includes(0)
        : startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
  if (!ok) throw new ExtractError(`Nội dung file không đúng định dạng .${kind}.`);
}

/** Chạy trong luồng phụ (worker.ts). Import động để luồng chỉ nạp thư viện của đúng loại file. */
export async function extractInThread(
  kind: ExtractKind,
  bytes: Uint8Array,
  limits: ExtractLimits,
): Promise<ExtractOutput> {
  checkMagic(kind, bytes);
  try {
    switch (kind) {
      case "docx":
        return await (await import("./docx.ts")).extractDocx(bytes, limits);
      case "pdf":
        return await (await import("./pdf.ts")).extractPdf(bytes, limits);
      case "xlsx":
        return await (await import("./xlsx.ts")).extractXlsx(bytes, limits);
      case "pptx":
        return await (await import("./pptx.ts")).extractPptx(bytes, limits);
      case "csv":
        return (await import("./csv.ts")).extractCsv(bytes, limits);
    }
  } catch (error) {
    if (error instanceof ExtractError) throw error;
    throw new ExtractError(`File .${kind} hỏng hoặc không đọc được.`);
  }
}
