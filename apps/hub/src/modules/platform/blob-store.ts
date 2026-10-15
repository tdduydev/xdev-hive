import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { lockBlobStorage, queueBlobGc } from "./blob-gc.ts";
import { type DocStorageLimits, loadDocStorageLimits } from "./config.ts";
import type { Tx } from "./db.ts";
import { BadRequestError, NotFoundError } from "./errors.ts";
import type { Jobs } from "./jobs.ts";
import { type BlobReader, inspectFileType } from "./magic.ts";
import { blobChunks, blobs } from "./schema.ts";

export const BLOB_CHUNK_BYTES = 512 * 1024;
export type BlobRef = typeof blobs.$inferSelect;
export interface BlobPutOptions {
  filename?: string;
  /** Chỉ tăng trần sau khi bên gọi đã kiểm chính sách LFS hoặc giới hạn của loại sản phẩm. */
  maxBytes?: number;
}
export interface BlobStore {
  put(
    tx: Tx,
    orgId: string,
    body: AsyncIterable<Uint8Array>,
    mediaType: string,
    options?: BlobPutOptions,
  ): Promise<BlobRef>;
  /** Phải đọc hết stream trong cùng withTenant; không trả stream ra sau khi transaction đã đóng. */
  get(tx: Tx, orgId: string, id: string): Promise<AsyncIterable<Uint8Array>>;
  stat(tx: Tx, orgId: string, id: string): Promise<BlobRef | null>;
}

function readerFor(tx: Tx, id: string, orgId: string, size: number): BlobReader {
  let cachedOrd = -1;
  let cached: Buffer = Buffer.alloc(0);
  return {
    size,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error("Vùng đọc file không hợp lệ.");
      const result = Buffer.alloc(length);
      for (let done = 0; done < length; ) {
        const ord = Math.floor((offset + done) / BLOB_CHUNK_BYTES);
        if (cachedOrd !== ord) {
          const [row] = await tx
            .select({ data: blobChunks.data })
            .from(blobChunks)
            .where(and(eq(blobChunks.blobId, id), eq(blobChunks.orgId, orgId), eq(blobChunks.ord, ord)));
          if (!row) throw new Error("Kho file thiếu đoạn dữ liệu.");
          cached = row.data;
          cachedOrd = ord;
        }
        const start = (offset + done) % BLOB_CHUNK_BYTES;
        const count = Math.min(length - done, cached.length - start);
        if (count <= 0) throw new Error("Kho file có đoạn dữ liệu sai kích thước.");
        cached.copy(result, done, start, start + count);
        done += count;
      }
      return result;
    },
  };
}

export function createPostgresBlobStore(options: { limits?: DocStorageLimits; jobs?: Jobs } = {}): BlobStore {
  const limits = options.limits ?? loadDocStorageLimits();
  const stat: BlobStore["stat"] = async (tx, orgId, id) => {
    const [row] = await tx
      .select()
      .from(blobs)
      .where(and(eq(blobs.id, id), eq(blobs.orgId, orgId)))
      .for("key share");
    return row ?? null;
  };
  return {
    stat,
    async put(tx, orgId, body, mediaType, putOptions = {}) {
      const maxBytes = putOptions.maxBytes ?? limits.assetMaxBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
        throw new BadRequestError("BLOB_LIMIT_INVALID", "Giới hạn file không hợp lệ.");
      await lockBlobStorage(tx, orgId);
      const savepoint = sql.identifier(`blob_${randomUUID().replaceAll("-", "")}`);
      await tx.execute(sql`savepoint ${savepoint}`);
      try {
        const [staged] = await tx
          .insert(blobs)
          .values({
            orgId,
            sha256: createHash("sha256").update(randomUUID()).digest("hex"),
            size: 0,
            chunkCount: 0,
            mediaType,
          })
          .returning();
        if (!staged) throw new Error("Không tạo được file trong kho.");
        let size = 0,
          ord = 0,
          filled = 0;
        let chunk = Buffer.alloc(BLOB_CHUNK_BYTES);
        const hash = createHash("sha256");
        const flush = async () => {
          await tx.insert(blobChunks).values({ blobId: staged.id, orgId, ord: ord++, data: chunk.subarray(0, filled) });
          chunk = Buffer.alloc(BLOB_CHUNK_BYTES);
          filled = 0;
        };
        for await (const part of body) {
          size += part.byteLength;
          if (!Number.isSafeInteger(size) || size > maxBytes)
            throw new BadRequestError("BLOB_TOO_LARGE", "File vượt giới hạn dung lượng cho phép.");
          hash.update(part);
          for (let offset = 0; offset < part.byteLength; ) {
            const count = Math.min(part.byteLength - offset, BLOB_CHUNK_BYTES - filled);
            chunk.set(part.subarray(offset, offset + count), filled);
            offset += count;
            filled += count;
            if (filled === BLOB_CHUNK_BYTES) await flush();
          }
        }
        if (filled) await flush();
        const detected = await inspectFileType(readerFor(tx, staged.id, orgId, size), putOptions.filename, mediaType);
        const sha256 = hash.digest("hex");
        const [existing] = await tx
          .select()
          .from(blobs)
          .where(and(eq(blobs.orgId, orgId), eq(blobs.sha256, sha256)));
        let result: BlobRef;
        if (existing) {
          await tx.delete(blobs).where(eq(blobs.id, staged.id));
          result = existing;
        } else {
          const [usage] = await tx
            .select({ bytes: sql<string>`coalesce(sum(${blobs.size}), 0)` })
            .from(blobs)
            .where(eq(blobs.orgId, orgId));
          if (BigInt(usage?.bytes ?? 0) + BigInt(size) > BigInt(limits.orgStorageBytes))
            throw new BadRequestError("BLOB_STORAGE_QUOTA", "Kho file của tổ chức đã hết dung lượng cho phép.");
          const [saved] = await tx
            .update(blobs)
            .set({ sha256, size, chunkCount: ord, mediaType: detected })
            .where(eq(blobs.id, staged.id))
            .returning();
          if (!saved) throw new Error("Không lưu được file trong kho.");
          result = saved;
        }
        if (options.jobs) await queueBlobGc(options.jobs, orgId, tx);
        await tx.execute(sql`release savepoint ${savepoint}`);
        return result;
      } catch (error) {
        // Bên gọi có thể bắt lỗi từng file rồi tiếp tục nhập; không để lại các đoạn đã ghi dở.
        await tx.execute(sql`rollback to savepoint ${savepoint}`);
        await tx.execute(sql`release savepoint ${savepoint}`);
        throw error;
      }
    },
    async get(tx, orgId, id) {
      const [ref] = await tx
        .select()
        .from(blobs)
        .where(and(eq(blobs.id, id), eq(blobs.orgId, orgId)))
        .for("share");
      if (!ref) throw new NotFoundError("BLOB_NOT_FOUND", "Không tìm thấy file trong tổ chức.");
      return (async function* () {
        let size = 0;
        for (let ord = 0; ord < ref.chunkCount; ord++) {
          const [row] = await tx
            .select({ data: blobChunks.data })
            .from(blobChunks)
            .where(and(eq(blobChunks.blobId, id), eq(blobChunks.orgId, orgId), eq(blobChunks.ord, ord)))
            .orderBy(asc(blobChunks.ord));
          if (!row) throw new Error("Kho file thiếu đoạn dữ liệu.");
          size += row.data.length;
          yield row.data;
        }
        if (size !== ref.size) throw new Error("Dung lượng file trong kho không khớp.");
      })();
    },
  };
}
