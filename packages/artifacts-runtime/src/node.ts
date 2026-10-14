import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIB_MANIFEST_FILE, type LibManifest, parseLibManifest } from "./manifest.ts";

/** Thư mục `dist/lib` do `scripts/build-lib.ts` dựng; hub phục vụ nó ở `/_artifact/lib/`. */
export const LIB_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "lib");

/** Đọc manifest đã dựng. Lỗi rõ ràng khi chưa chạy `pnpm --filter @xdev-hive/artifacts-runtime build`. */
export function readLibManifest(libDir: string = LIB_DIST_DIR): LibManifest {
  let raw: string;
  try {
    raw = readFileSync(join(libDir, LIB_MANIFEST_FILE), "utf8");
  } catch (cause) {
    throw new Error(
      `Chưa có ${LIB_MANIFEST_FILE} trong ${libDir}: chạy "pnpm --filter @xdev-hive/artifacts-runtime build"`,
      {
        cause,
      },
    );
  }
  return parseLibManifest(JSON.parse(raw));
}
