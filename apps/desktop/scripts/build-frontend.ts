// Giao diện đăng ký máy là vài file tĩnh: chép HTML, CSS và bỏ kiểu của app.ts, không cần bundler.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(`${desktop}dist`, { recursive: true });
for (const name of ["index.html", "style.css"]) copyFileSync(`${desktop}src/${name}`, `${desktop}dist/${name}`);
writeFileSync(`${desktop}dist/app.js`, stripTypeScriptTypes(readFileSync(`${desktop}src/app.ts`, "utf8")));
