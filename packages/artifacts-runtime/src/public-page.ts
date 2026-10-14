import { escapeHtml } from "./frame-document.ts";

export interface PublicPageInput {
  title: string;
  type: string;
  version: number;
  expiresAt: Date | string;
  /** URL tuyệt đối tới `/_artifact/frame/<vé>` của hub. */
  frameUrl: string;
}

function parseFrameUrl(frameUrl: string): URL {
  if (/[\s;,'"<>]/.test(frameUrl)) throw new Error("frameUrl chứa ký tự không hợp lệ");
  const url = new URL(frameUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("frameUrl phải là http(s)");
  return url;
}

/**
 * CSP của trang công khai (FR-143). `frame-src` chỉ trỏ tới thư mục khung trên host của hub, nên phụ thuộc vào host và không
 * thể là hằng số cho mọi nơi triển khai. Không có `script-src`: `default-src 'none'` đã cấm mọi script.
 */
export function buildPublicPageCsp({ frameUrl }: { frameUrl: string }): string {
  const url = parseFrameUrl(frameUrl);
  const dir = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    `frame-src ${url.protocol}//${url.host}${dir}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Header đi kèm trang công khai (FR-143). Người gọi thêm `Content-Type: text/html; charset=utf-8`. */
export function publicPageHeaders({ frameUrl }: { frameUrl: string }): Record<string, string> {
  return {
    "Content-Security-Policy": buildPublicPageCsp({ frameUrl }),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
  };
}

function formatExpiry(expiresAt: Date | string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) throw new Error("expiresAt không hợp lệ");
  // Trang không có script nên không đổi được sang giờ của người xem; ghi UTC cho khỏi hiểu nhầm.
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const CSS = `body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fff;color:#18181b}main{max-width:960px;margin:0 auto;padding:2rem 1rem;display:flex;flex-direction:column;gap:1rem}h1{margin:0;font-size:1.25rem;overflow-wrap:anywhere}.meta{margin:0;color:#52525b;font-family:ui-monospace,monospace}.notice{margin:0;padding:.75rem 1rem;border:1px solid #d97706;border-radius:8px;background:#fffbeb;color:#92400e}iframe{width:100%;height:75vh;min-height:360px;border:1px solid #d4d4d8;border-radius:8px;background:#fff}@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}.meta{color:#a1a1aa}.notice{background:#451a03;border-color:#b45309;color:#fcd34d}iframe{border-color:#3f3f46}}`;

/**
 * Trang tĩnh của link công khai (FR-143): chỉ tiêu đề, loại, số phiên bản, hạn, nhãn cảnh báo và một iframe sandbox. Không có
 * script nào, nên mọi chữ lấy từ dữ liệu của agent (tiêu đề) phải escape; không lộ tổ chức, chủ hay dự án.
 */
export function buildPublicPage({ title, type, version, expiresAt, frameUrl }: PublicPageInput): string {
  parseFrameUrl(frameUrl);
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${safeTitle}</title><style>${CSS}</style></head><body><main><header><h1>${safeTitle}</h1><p class="meta">${escapeHtml(type)} · v${Math.trunc(version)} · Hết hạn ${formatExpiry(expiresAt)}</p></header><p class="notice" role="note">Nội dung do agent tạo — không nhập mật khẩu hay dữ liệu bí mật.</p><iframe sandbox="allow-scripts" src="${escapeHtml(frameUrl)}" title="${safeTitle}" referrerpolicy="no-referrer"></iframe></main></body></html>`;
}
