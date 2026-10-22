import type { Redactor } from "@xdev-hive/contracts";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { NotFoundError, type Tx } from "../platform/index.ts";
import { deployLogChunks, deploys } from "./schema.ts";

// Log của lần triển khai (FR-019, plan.md mục 7): che bí mật trước khi ghi, ghi theo đoạn `bytea`, báo cho luồng SSE
// bằng NOTIFY. Bảng riêng, không dùng `run_logs`, vì lần triển khai không có run.

/** Kênh LISTEN/NOTIFY; payload là id lần triển khai. */
export const DEPLOY_LOG_CHANNEL = "hive_deploy_logs";

// Một đoạn log dài (build in cả megabyte) được cắt để mỗi dòng bảng và mỗi sự kiện SSE vừa phải. Cắt theo ký tự chứ không
// theo byte, để không bao giờ xẻ đôi một ký tự UTF-8 hay cặp surrogate.
const MAX_CHUNK_CHARS = 16 * 1024;

export interface DeployLogChunk {
  /** Con trỏ cho SSE (`Last-Event-ID`) và `logsAfter`; tăng dần trên toàn bảng. */
  id: number;
  /** Thứ tự trong lần triển khai, từ 1, liền nhau. */
  seq: number;
  /** UTF-8, base64, giống log của run. */
  bytes: string;
  createdAt: string;
}

/** Báo luồng SSE đang nghe: có log mới hoặc trạng thái lần triển khai vừa đổi. Tới nơi khi transaction commit. */
export async function notifyDeploy(tx: Tx, deployId: string): Promise<void> {
  await tx.execute(sql`select pg_notify(${DEPLOY_LOG_CHANNEL}, ${deployId})`);
}

function pieces(text: string): string[] {
  const out: string[] = [];
  for (let from = 0; from < text.length; ) {
    let to = Math.min(from + MAX_CHUNK_CHARS, text.length);
    const last = text.charCodeAt(to - 1);
    // Không cắt giữa cặp surrogate (emoji, chữ ngoài BMP).
    if (to < text.length && last >= 0xd800 && last <= 0xdbff) to--;
    out.push(text.slice(from, to));
    from = to;
  }
  return out;
}

/**
 * Che `text` bằng `redactor` rồi ghi. `redactor` phải là một đối tượng cho cả lần triển khai: nó giữ lại đuôi của đoạn
 * trước để che được bí mật bị cắt ngang giữa hai đoạn, nên phần đuôi chỉ được ghi ở lần gọi sau hoặc ở `flushDeployLog`.
 * Trả số dòng đã ghi (0 khi toàn bộ còn được giữ lại).
 */
export async function appendDeployLog(tx: Tx, deployId: string, text: string, redactor: Redactor): Promise<number> {
  return write(tx, deployId, redactor.push(text));
}

/** Hết log (lần triển khai kết thúc): ghi nốt phần đuôi redactor còn giữ. */
export async function flushDeployLog(tx: Tx, deployId: string, redactor: Redactor): Promise<number> {
  return write(tx, deployId, redactor.flush());
}

async function write(tx: Tx, deployId: string, masked: string): Promise<number> {
  // RLS giới hạn trong tổ chức của giao dịch, nên id lạ hoặc của tổ chức khác đều là "không thấy".
  const [deploy] = await tx.select({ orgId: deploys.orgId }).from(deploys).where(eq(deploys.id, deployId));
  if (!deploy) throw new NotFoundError("NOT_FOUND", "Không tìm thấy lần triển khai.");
  if (masked === "") return 0;

  // Hai người ghi cùng lần triển khai (watch chạy lại sau khi hub chết) sẽ đua nhau lấy `seq`; khoá theo lần triển khai
  // cho đến hết giao dịch để `seq` liền nhau và không đụng ràng buộc duy nhất.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${deployId}, 0))`);
  const [{ next } = { next: 1 }] = (
    await tx.execute<{ next: number }>(
      sql`select coalesce(max(seq), 0) + 1 as next from hive.deploy_log_chunks where deploy_id = ${deployId}`,
    )
  ).rows;
  const rows = pieces(masked).map((piece, i) => ({
    orgId: deploy.orgId,
    deployId,
    seq: Number(next) + i,
    data: Buffer.from(piece, "utf8"),
  }));
  await tx.insert(deployLogChunks).values(rows);
  await notifyDeploy(tx, deployId);
  return rows.length;
}

/** Các đoạn có `id` lớn hơn `after`, theo thứ tự ghi. */
export async function logsAfter(tx: Tx, deployId: string, after: number, limit: number): Promise<DeployLogChunk[]> {
  const rows = await tx
    .select()
    .from(deployLogChunks)
    .where(and(eq(deployLogChunks.deployId, deployId), gt(deployLogChunks.id, after)))
    .orderBy(asc(deployLogChunks.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    bytes: r.data.toString("base64"),
    createdAt: r.createdAt.toISOString(),
  }));
}
