// Pandoc giả thành công: ghi lại tham số và env nhận được vào out.md, sinh log.json và một ảnh như pandoc thật.
import { mkdirSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write("pandoc 3.12\nFeatures: +server +lua\n");
  process.exit(0);
}
mkdirSync("m/media", { recursive: true });
writeFileSync("m/media/rId9.png", "png");
writeFileSync("out.md", JSON.stringify({ argv, env: process.env }));
writeFileSync("log.json", JSON.stringify([{ type: "ScriptingWarning", verbosity: "WARNING", message: "no_h1" }]));
