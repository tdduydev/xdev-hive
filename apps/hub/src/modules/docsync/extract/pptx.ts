import { xmlText } from "./markdown.ts";
import { ExtractError, type ExtractLimits, type ExtractOutput } from "./types.ts";
import { entryText, readZip, type ZipEntries } from "./zip.ts";

const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;

/** Chữ theo đoạn `<a:p>`; mỗi đoạn một dòng. Đủ cho tìm kiếm, không dựng lại bố cục slide. */
function paragraphs(xml: string): string[] {
  const lines: string[] = [];
  for (const [p] of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
    const text = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => xmlText(m[1] ?? "")).join("");
    if (text.trim()) lines.push(text.trim());
  }
  return lines;
}

function notesOf(entries: ZipEntries, slide: number): string[] {
  const rels = entryText(entries, `ppt/slides/_rels/slide${slide}.xml.rels`);
  const target = rels && /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels)?.[1];
  const xml = target ? entryText(entries, `ppt/notesSlides/${target}`) : null;
  // Ghi chú có ô số trang chỉ chứa số; bỏ để không lẫn vào nội dung.
  return xml ? paragraphs(xml).filter((line) => !/^\d+$/.test(line)) : [];
}

export async function extractPptx(bytes: Uint8Array, limits: ExtractLimits): Promise<ExtractOutput> {
  const entries = await readZip(bytes, limits);
  const slides = [...entries.keys()]
    .map((name) => Number(SLIDE.exec(name)?.[1]))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  if (!slides.length) throw new ExtractError("File PowerPoint không có slide nào hoặc đã hỏng.");
  const warnings = slides.length > limits.slides ? [`Chỉ trích ${limits.slides}/${slides.length} slide đầu.`] : [];
  const parts: string[] = [];
  for (const [i, n] of slides.slice(0, limits.slides).entries()) {
    const lines = paragraphs(entryText(entries, `ppt/slides/slide${n}.xml`) ?? "");
    const notes = notesOf(entries, n);
    if (!lines.length && !notes.length) continue;
    const body = [...lines, ...(notes.length ? ["**Ghi chú:**", ...notes] : [])].join("\n\n");
    parts.push(`## Slide ${i + 1}\n\n${body}`);
  }
  if (!parts.length) throw new ExtractError("Không có chữ để trích.");
  return { markdown: parts.join("\n\n"), warnings };
}
