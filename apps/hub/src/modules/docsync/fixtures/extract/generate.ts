/*
 * Sinh lại mẫu cho test trích nội dung: `node src/modules/docsync/fixtures/extract/generate.ts` trong apps/hub.
 * Mẫu tự dựng, nhỏ và cố định (không ngẫu nhiên) để file commit không đổi giữa các lần sinh.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const out = (name: string) => new URL(`./${name}`, import.meta.url);
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const zipOf = (files: Record<string, string | Uint8Array>) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data, { date: new Date("2026-10-15T00:00:00Z") });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
};

function docx(): Promise<Buffer> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const p = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  return zipOf({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "word/styles.xml": `${XML}<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
    "word/document.xml": `${XML}<w:document ${W}><w:body>${[
      p("Quy trình phát hành", "Heading1"),
      p("Mỗi bản phát hành đi qua nhánh release."),
      p("Kiểm tra trước khi phát hành", "Heading2"),
      p("Chạy test, xem lại ghi chú phát hành &amp; changelog."),
    ].join("")}</w:body></w:document>`,
  });
}

async function xlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = wb.modified = new Date("2026-10-15T00:00:00Z");
  const plan = wb.addWorksheet("Kế hoạch");
  plan.addRows([
    ["Hạng mục", "Người làm", "Hạn"],
    ["Thiết kế", "An", "2026-10-20"],
    ["Làm | kiểm", "Bình", "2026-10-30"],
  ]);
  wb.addWorksheet("Trống");
  const many = wb.addWorksheet("Nhiều dòng");
  many.addRow(["STT", "Giá trị"]);
  for (let i = 1; i <= 30; i++) many.addRow([i, i * 10]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pptx(): Promise<Buffer> {
  const A =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
  const slide = (...paras: string[]) =>
    `${XML}<p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody>${paras
      .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
      .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return zipOf({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    "ppt/slides/slide1.xml": slide("Lộ trình quý 4", "Ba mục tiêu chính"),
    "ppt/slides/slide2.xml": slide("Mục tiêu 1: đồng bộ tài liệu", "Hub &lt;-&gt; repo"),
    // slide10 đứng sau slide2: thứ tự phải theo số, không theo tên.
    "ppt/slides/slide10.xml": slide("Kết thúc"),
    "ppt/slides/_rels/slide2.xml.rels": `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    "ppt/notesSlides/notesSlide1.xml": slide("Nhắc đội nền tảng chuẩn bị máy chủ.", "2"),
  });
}

/** PDF tối thiểu, xref tính đúng offset. `extra` thêm vào trailer (ví dụ /Encrypt). */
function pdf(pages: string[], opts: { extraObjects?: string[]; trailer?: string } = {}): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (const [i, text] of pages.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
  }
  objects.push(...(opts.extraObjects ?? []));
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${opts.trailer ?? ""}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const text = (...lines: string[]) =>
  `BT /F1 14 Tf 72 720 Td 18 TL ${lines.map((l, i) => `${i ? "T* " : ""}(${l}) Tj`).join(" ")} ET`;
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

function encryptedPdf(): Buffer {
  // /O, /U cố định nhưng không khớp mật khẩu rỗng: pdf.js phải hỏi mật khẩu (PasswordException).
  const encrypt = `<< /Filter /Standard /V 1 /R 2 /O <${hex("owner")}> /U <${hex("user")}> /P -4 >>`;
  return pdf([text("Noi dung mat")], {
    extraObjects: [encrypt],
    trailer: `/Encrypt 6 0 R /ID [<${hex("id").slice(0, 32)}> <${hex("id").slice(0, 32)}>] `,
  });
}

/** Zip bomb nhỏ: một entry 64 MiB số 0 nén còn khoảng 64 KB. Test hạ giới hạn giải nén để chạy nhanh. */
function bomb(): Promise<Buffer> {
  return zipOf({
    "[Content_Types].xml": `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "word/document.xml": new Uint8Array(64 * 1024 ** 2),
  });
}

const files: Record<string, Buffer | Promise<Buffer>> = {
  "sample.docx": docx(),
  "sample.xlsx": xlsx(),
  "sample.pptx": pptx(),
  "sample.pdf": pdf([text("Bao cao quy 3", "Doanh thu tang 12%"), text("Trang hai")]),
  "scanned.pdf": pdf(["q 0 0 1 rg 72 72 200 200 re f Q"]),
  "encrypted.pdf": encryptedPdf(),
  "sample.csv": Buffer.from('Tên;Vai trò;Ghi chú\nAn;Quản trị;"Có ; trong ô"\nBình;Thành viên;"Hai\ndòng"\n'),
  "broken.docx": Buffer.from("PK\u0003\u0004 không phải zip thật, file bị cắt giữa chừng"),
  "broken.pdf": Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R"),
  "renamed.xlsx": Buffer.from("Đây là file văn bản bị đổi đuôi thành .xlsx"),
  "bomb.docx": bomb(),
};

for (const [name, data] of Object.entries(files)) await writeFile(out(name), await data);
