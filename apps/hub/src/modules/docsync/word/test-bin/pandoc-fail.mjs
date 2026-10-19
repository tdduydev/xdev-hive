// Pandoc giả thoát lỗi: stderr dài, có đường dẫn thư mục tạm như pandoc thật khi đọc hỏng file.
const lines = Array.from({ length: 50 }, (_, i) => `dòng chẩn đoán ${i}`);
lines.push(`couldn't unpack docx container: ${process.cwd()}/in.docx`);
process.stderr.write(`${lines.join("\n")}\n`);
process.exit(64);
