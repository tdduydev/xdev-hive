import { writeFile } from "node:fs/promises";
import { hubDataMarkdown } from "../src/hub-data.ts";

await writeFile(new URL("../../../docs/hub-data.md", import.meta.url), hubDataMarkdown());
