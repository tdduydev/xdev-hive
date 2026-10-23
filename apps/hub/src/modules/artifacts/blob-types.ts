import type { ArtifactType } from "@xdev-hive/contracts";

/*
 * Ảnh và PDF (T062) lưu ở `BlobStore` của platform, không phải ở cột `content`. SVG không vào đây: nó là chữ, có loại
 * `svg` riêng và đi qua khung cách ly như `html`.
 */

/** Loại MIME nhận cho từng loại artifact; `inspectFileType` đã đối chiếu với magic bytes khi lưu. */
export const BLOB_MEDIA_TYPES = {
  image: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  pdf: ["application/pdf"],
} as const satisfies Partial<Record<ArtifactType, readonly string[]>>;

export type BlobArtifactType = keyof typeof BLOB_MEDIA_TYPES;

export const isBlobType = (type: ArtifactType): type is BlobArtifactType => type in BLOB_MEDIA_TYPES;

/** Loại artifact của một tệp theo MIME đã kiểm; null khi tệp không phải ảnh/PDF nhận được. */
export function blobTypeOf(mediaType: string): BlobArtifactType | null {
  for (const type of Object.keys(BLOB_MEDIA_TYPES) as BlobArtifactType[])
    if ((BLOB_MEDIA_TYPES[type] as readonly string[]).includes(mediaType)) return type;
  return null;
}
