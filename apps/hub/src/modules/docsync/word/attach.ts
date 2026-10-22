import { WORD_IMPORT_ERRORS, type WordImportErrorCode } from "@xdev-hive/contracts";
import { and, eq } from "drizzle-orm";
import { createPostgresBlobStore, type Tx } from "../../platform/index.ts";
import { isLfsPath, parseGitattributes } from "../content.ts";
import type { HomeRow } from "../homes.ts";
import { docAssets, docRepoFiles } from "../schema.ts";
import type { WordImportFileRow } from "./tools.ts";

// Phần chung của bước tạo (commit.ts) và bước cập nhật (update.ts). Tách riêng vì commit.ts gọi update.ts: update.ts
// import ngược commit.ts thì thành vòng phụ thuộc.

type FileError = NonNullable<WordImportFileRow["error"]>;

export const fileError = (code: WordImportErrorCode, message?: string): FileError => ({
  code,
  message: message ?? WORD_IMPORT_ERRORS[code].message,
});

/** Lỗi của riêng một file: ghi vào file rồi đi tiếp, không làm hỏng cả lượt. */
export class FileFailure extends Error {
  readonly error: FileError;

  constructor(error: FileError) {
    super(error.message);
    this.error = error;
  }
}

/** Như `homeDir` của assets.ts (chưa export): ảnh của nhà dự án nằm ở gốc nhà, nhà tổ chức tách theo đội. */
function homeDir(home: HomeRow, key: string): string {
  const root = home.root.replace(/\/+$/, "");
  if (home.scope === "project") return root;
  const team = /^team\/([a-z0-9-]+)\//.exec(key)?.[1];
  return [root, team ? `teams/${team}` : "org"].filter(Boolean).join("/");
}

export function assetsDirOf(home: HomeRow, key: string): string {
  return [homeDir(home, key), home.assetsDir.replace(/^\/+|\/+$/g, "")].filter(Boolean).join("/");
}

const FRONT_MATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Bỏ front matter ở đầu Markdown (như `countStats` của postprocess.ts) và các dòng trống ngay sau nó. */
export function stripFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER, "").replace(/^(?:[ \t]*\r?\n)+/, "");
}

/**
 * Ghi đúng đường dẫn đã chọn. Hook lưu của docsync đã gắn tài liệu vào đường dẫn suy từ key (chữ thường), nên sửa
 * dòng đó thay vì thêm dòng thứ hai. Nhà tắt đồng bộ thì hook không gắn, ở đây cũng không.
 */
export async function pinPath(tx: Tx, home: HomeRow, docId: string, path: string): Promise<void> {
  if (home.mode === "off") return;
  const [row] = await tx.select().from(docRepoFiles).where(eq(docRepoFiles.docId, docId));
  if (row) {
    await tx
      .update(docRepoFiles)
      .set({ repoPath: path, state: "pending", updatedAt: new Date() })
      .where(eq(docRepoFiles.id, row.id));
    return;
  }
  await tx.insert(docRepoFiles).values({ orgId: home.orgId, homeId: home.id, docId, repoPath: path, state: "pending" });
}

const blobStore = createPostgresBlobStore();

/** Ảnh vào thư mục ảnh của nhà, trỏ tới blob đã có từ lúc chuyển; lô đẩy kế tiếp ghi chúng cùng tài liệu. */
export async function attachImages(
  tx: Tx,
  home: HomeRow,
  images: WordImportFileRow["images"],
  docId: string,
  key: string,
): Promise<void> {
  const dir = assetsDirOf(home, key);
  const rules = parseGitattributes(home.lfsPatterns.map((p) => `${p} filter=lfs`).join("\n"));
  for (const image of images) {
    const repoPath = `${dir}/${image.name}`;
    const blob = await blobStore.stat(tx, home.orgId, image.blobId);
    if (!blob)
      throw new FileFailure(
        fileError(
          "WORD_IMPORT_CONVERT_FAILED",
          "Ảnh tách từ file Word không còn trong kho file. Tải file Word lên lại.",
        ),
      );
    const [existing] = await tx
      .select()
      .from(docAssets)
      .where(and(eq(docAssets.homeId, home.id), eq(docAssets.repoPath, repoPath)))
      .for("update");
    if (existing) {
      if (existing.sha256 !== blob.sha256)
        throw new FileFailure(
          fileError(
            "WORD_IMPORT_EXISTS",
            `Thư mục ảnh đã có ${image.name} khác nội dung. Đổi file ảnh trong repo rồi tạo lại.`,
          ),
        );
      // Ảnh đang chờ xoá vì không còn ai trỏ tới thì giữ lại: tài liệu này trỏ tới nó.
      if (existing.state === "pending_delete")
        await tx
          .update(docAssets)
          .set({ state: "available", updatedAt: new Date() })
          .where(eq(docAssets.id, existing.id));
      continue;
    }
    await tx
      .insert(docAssets)
      .values({
        orgId: home.orgId,
        homeId: home.id,
        repoPath,
        blobId: blob.id,
        mediaType: blob.mediaType,
        size: blob.size,
        sha256: blob.sha256,
        lfs: isLfsPath(repoPath, rules),
        state: "pending_push",
        ownerDocId: docId,
      })
      .onConflictDoNothing();
  }
}
