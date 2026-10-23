/** Chữ thuần trông như Markdown (dán từ file .md, chat, trình soạn code): nạp thành khối thay vì dán nguyên ký hiệu. */
export function looksLikeMarkdown(text: string): boolean {
  return (
    /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|~~~|\|.*\|\s*$)/m.test(text) ||
    /\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`/.test(text)
  );
}

const OFFICE = /urn:schemas-microsoft-com|class="?Mso|mso-/i;

/**
 * HTML dán từ Word: bỏ phần riêng của Office và đổi đoạn danh sách (MsoListParagraph, ký hiệu đầu dòng là chữ) thành
 * danh sách thật để xuất ra `-`/`1.` thay vì đoạn văn bắt đầu bằng "·". Google Docs đã dùng <ul>/<ol> nên giữ nguyên.
 */
export function cleanPastedHtml(html: string): string {
  if (!OFFICE.test(html)) return html;
  const doc = new DOMParser().parseFromString(html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, ""), "text/html");
  for (const el of Array.from(doc.querySelectorAll("style, meta, link, title"))) el.remove();
  for (const el of Array.from(doc.getElementsByTagName("o:p"))) el.remove();
  let stack: HTMLElement[] = [];
  let listId = "";
  for (const p of Array.from(doc.body.querySelectorAll("p"))) {
    const style = p.getAttribute("style") ?? "";
    const list = /mso-list:\s*(l\d+)\s+level(\d+)/i.exec(style);
    const level = Number(list?.[2] ?? 0);
    if (!level && !/MsoListParagraph/i.test(p.className)) {
      stack = [];
      continue;
    }
    // Word đánh mã riêng (l0, l1…) cho từng danh sách: hai danh sách liền nhau vẫn tách ra.
    if (list && list[1] !== listId) stack = [];
    listId = list?.[1] ?? listId;
    const marker = Array.from(p.querySelectorAll("span")).find((s) =>
      /mso-list:\s*ignore/i.test(s.getAttribute("style") ?? ""),
    );
    const ordered = /^\s*([0-9]+|[a-z]|[ivxlc]+)[.)]/i.test(marker?.textContent ?? "");
    marker?.remove();
    // Đoạn danh sách không liền ngay danh sách trước: bắt đầu danh sách mới.
    if (stack[0] && stack[0].nextElementSibling !== p) stack = [];
    const depth = Math.max(level, 1);
    while (stack.length > depth) stack.pop();
    while (stack.length < depth) {
      const list = doc.createElement(ordered ? "ol" : "ul");
      const parentItem = stack.at(-1)?.lastElementChild;
      if (parentItem) parentItem.append(list);
      else p.before(list);
      stack.push(list);
    }
    const li = doc.createElement("li");
    li.append(...Array.from(p.childNodes));
    stack.at(-1)?.append(li);
    p.remove();
  }
  return doc.body.innerHTML;
}

/** Địa chỉ không có scheme, không bắt đầu bằng `/`, `//` hay `#`: nằm trong repo cạnh tài liệu, hub mới phân giải được. */
export const isRelativeHref = (href: string) => !!href && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href);

/** Địa chỉ ảnh trình duyệt được phép tải: http(s) hoặc đường dẫn cùng gốc; chặn `javascript:` và `data:` trong `src` của ảnh. */
export const isSafeImageUrl = (url: string) => /^(https?:\/\/|\/(?!\/))/i.test(url);

/**
 * Ảnh raster nhúng thẳng (base64). Chỉ nhận khi app chủ trả qua `resolveLink`, không nhận trong `src` của tài liệu: app
 * desktop không tải ảnh từ hub bằng thẻ img được (token nằm trong Rust, CSP chặn `blob:`), nên đọc byte rồi đưa vào đây.
 * Không có SVG vì SVG chạy được script.
 */
export const isInlineImageUrl = (url: string) =>
  /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(url);

/** File trong sự kiện dán hoặc thả. Dán ảnh chụp màn hình hay ảnh sao chép có `items`; thả file có `files`. */
export function transferFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  return Array.from(data.items ?? [])
    .filter((i) => i.kind === "file")
    .flatMap((i) => i.getAsFile() ?? []);
}

/**
 * Dán chỉ lấy file khi clipboard không có chữ: bảng tính hay Word sao chép ra cả ảnh lẫn chữ, và người dùng muốn chữ.
 * Ảnh chụp màn hình và "Sao chép ảnh" của trình duyệt không kèm chữ thuần.
 */
export const pastedFiles = (data: DataTransfer | null): File[] =>
  data?.getData("text/plain") ? [] : transferFiles(data);

const pad = (n: number) => String(n).padStart(2, "0");

/** Ảnh dán không có tên thật (clipboard đặt "image.png"): đặt `image-<yyyymmdd-hhmmss>.<đuôi>` như hub (plan.md mục 8). */
export function nameClipboardImage(file: File, now = new Date()): File {
  if (!/^image\.\w+$/i.test(file.name) && file.name) return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*/, "") || "png";
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return new File([file], `image-${stamp}.${ext}`, { type: file.type });
}

/** Đường dẫn hub trả về đưa vào `](…)`: chỉ mã hoá ký tự làm Markdown đọc sai, giữ nguyên chữ có dấu cho dễ đọc. */
export const markdownPath = (path: string) =>
  path.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
