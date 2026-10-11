import { parseArgs } from "node:util";
import { createOpenAIEmbedder, embedQueue, importLegacy } from "./modules/knowledge/index.ts";
import { createJobs, createPool, loadConfig } from "./modules/platform/index.ts";

const usage =
  "Cách dùng: pnpm --filter @xdev-hive/hub import:legacy --db <sqlite> --org <slug> [--project-map old=new,...] [--dry-run]";

try {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      org: { type: "string" },
      "project-map": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  if (!values.db || !values.org) throw new Error(usage);
  const projectMap = new Map<string, string>();
  if (values["project-map"] !== undefined) {
    for (const pair of values["project-map"].split(",")) {
      const parts = pair.split("=").map((s) => s.trim());
      const [oldKey, newKey] = parts;
      if (parts.length !== 2 || !oldKey || !newKey || projectMap.has(oldKey))
        throw new Error("Ánh xạ dự án cần có dạng old=new và không lặp key nguồn.");
      projectMap.set(oldKey, newKey);
    }
  }
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("Cần đặt HIVE_DATABASE_URL của role hive_app.");
  if (!values["dry-run"] && config.embeddings && !config.jobsDatabaseUrl)
    throw new Error("Cần HIVE_DATABASE_JOBS_URL để tạo lại embedding qua hàng đợi.");
  const pool = createPool(config.databaseUrl);
  const jobs =
    !values["dry-run"] && config.embeddings && config.jobsDatabaseUrl
      ? createJobs({
          connectionString: config.jobsDatabaseUrl,
          queues: [embedQueue],
          maintenance: false,
          onError: () => console.error("Hàng đợi embedding gặp lỗi."),
        })
      : undefined;
  try {
    if (jobs) await jobs.start();
    const report = await importLegacy(
      pool,
      { db: values.db, org: values.org, projectMap, dryRun: values["dry-run"] ?? false },
      { jobs, embedder: config.embeddings ? createOpenAIEmbedder(config.embeddings) : undefined },
    );
    console.log(
      values["dry-run"] ? "Chạy thử, không ghi dữ liệu. Số mục có thể thêm:" : "Đã chuyển dữ liệu. Số mục nguồn:",
    );
    const labels = {
      memory: "Memory",
      doc: "Tài liệu",
      docVersion: "Phiên bản tài liệu",
      skill: "Skill",
      skillVersion: "Phiên bản skill",
      asset: "Tệp đính kèm",
    };
    for (const kind of Object.keys(report) as Array<keyof typeof report>) {
      const row = report[kind];
      console.log(`${labels[kind]}: thêm ${row.added}, bỏ qua ${row.skipped}, lỗi ${row.errors}.`);
      for (const [reason, n] of Object.entries(row.reasons)) console.log(`  ${reason} (${n})`);
    }
    if (Object.values(report).some((c) => c.errors > 0)) process.exitCode = 1;
  } finally {
    try {
      if (jobs) await jobs.stop();
    } finally {
      await pool.end();
    }
  }
} catch {
  // Lỗi driver/SQLite có thể kèm câu SQL, đường dẫn hoặc nội dung nội bộ; CLI chỉ xuất thông báo tổng quát.
  console.error(
    `Không chạy được import. Kiểm tra tham số, SQLite chỉ đọc, role hive_app, migration và kết nối database.\n${usage}`,
  );
  process.exitCode = 2;
}
