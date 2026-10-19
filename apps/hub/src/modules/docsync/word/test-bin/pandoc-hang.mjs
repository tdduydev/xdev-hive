// Pandoc giả treo: ghi pid (trừ khi hỏi --version, lúc đó cwd không phải thư mục tạm) để test kiểm tiến trình đã chết,
// bỏ qua SIGTERM để chỉ SIGKILL dừng được.
import { writeFileSync } from "node:fs";

if (process.argv[2] !== "--version") writeFileSync("pid", String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 60_000);
