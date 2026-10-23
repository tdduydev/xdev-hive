// Sinh openapi.json từ hợp đồng. Worker Go sinh client từ file này (oapi-codegen), nên file được commit và CI kiểm nó khớp.
// Sinh luôn fixtures/client-write-tools.json: test Go đọc file này để bảng nhóm tool của hộp thư đi khớp hub.
import { writeFile } from "node:fs/promises";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { clientWriteToolsFixture, contract } from "../src/index.ts";

const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
const spec = await generator.generate(contract, {
  info: { title: "xDev Hive API", version: "0.0.0" },
  servers: [{ url: "/api" }],
});
await writeFile(new URL("../openapi.json", import.meta.url), `${JSON.stringify(spec, null, 2)}\n`);
await writeFile(
  new URL("../fixtures/client-write-tools.json", import.meta.url),
  `${JSON.stringify(clientWriteToolsFixture(), null, 2)}
`,
);
