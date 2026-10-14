import { z } from "zod";

/** Nằm trong `dist/lib` để chép thư mục `lib` là mang theo cả manifest (Dockerfile, resource của app). */
export const LIB_MANIFEST_FILE = "lib-manifest.json";

export const libEntrySchema = z.strictObject({
  /** Đường dẫn tương đối so với `libBase`, dạng `<tên>@<ver>/<file>`. */
  path: z.string().min(1),
  /** SRI `sha384-…` của đúng file ở `path`. */
  integrity: z.string().regex(/^sha384-[A-Za-z0-9+/]+={0,2}$/),
  /** `module` nạp qua import map; `script` (Tailwind) nạp bằng thẻ `<script src>`. */
  kind: z.enum(["module", "script"]),
  bytes: z.number().int().nonnegative(),
});

/** Khoá là tên import (`react`, `react/jsx-runtime`, `recharts`, …). */
export const libManifestSchema = z.record(z.string().min(1), libEntrySchema);

export type LibEntry = z.infer<typeof libEntrySchema>;
export type LibManifest = z.infer<typeof libManifestSchema>;

export function parseLibManifest(json: unknown): LibManifest {
  return libManifestSchema.parse(json);
}
