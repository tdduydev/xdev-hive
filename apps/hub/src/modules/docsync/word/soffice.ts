// LibreOffice đổi `.doc` thành `.docx` (plan.md mục 12b). Chưa làm nên luôn báo không có: hub vẫn nhận `.docx`, `.odt`.

export interface SofficeCheck {
  ok: boolean;
  version: string | null;
  reason: string | null;
}

export async function detectSoffice(_path: string, _opts: { timeoutMs?: number } = {}): Promise<SofficeCheck> {
  return { ok: false, version: null, reason: "Hub chưa hỗ trợ nhận .doc." };
}
