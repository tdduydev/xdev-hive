export type ExtractKind = "docx" | "pdf" | "xlsx" | "csv" | "pptx";

export interface ExtractLimits {
  /** Tổng byte sau giải nén của mọi entry trong file Office. Heap 512 MB không tính Buffer nên phải tự đếm. */
  unzippedBytes: number;
  zipEntries: number;
  pdfPages: number;
  sheets: number;
  rowsPerSheet: number;
  slides: number;
}

export const EXTRACT_LIMITS: ExtractLimits = {
  unzippedBytes: 200 * 1024 ** 2,
  zipEntries: 5_000,
  pdfPages: 500,
  sheets: 20,
  rowsPerSheet: 2_000,
  slides: 500,
};

export interface ExtractOutput {
  markdown: string;
  warnings: string[];
}

/** Lỗi do chính file (hỏng, có mật khẩu, quá giới hạn): ghi vào bản trích, không thử lại job. */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}
