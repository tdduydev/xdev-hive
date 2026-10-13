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
  for (const p of Array.from(doc.body.querySelectorAll("p"))) {
    const style = p.getAttribute("style") ?? "";
    const level = Number(/mso-list:\s*l\d+\s+level(\d+)/i.exec(style)?.[1] ?? 0);
    if (!level && !/MsoListParagraph/i.test(p.className)) {
      stack = [];
      continue;
    }
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
