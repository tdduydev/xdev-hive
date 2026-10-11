import { PgBoss, type Queue } from "pg-boss";
import type { Tx } from "./db.ts";

/** Schema của pg-boss, do bootstrapRoles tạo sẵn với chủ là hive_jobs. */
export const JOBS_SCHEMA = "pgboss";

export interface JobQueue extends Omit<Queue, "name"> {
  name: string;
}

export interface JobRun<T> {
  id: string;
  data: T;
  /** Số lần đã thử lại trước lần này (0 ở lần đầu). */
  retryCount: number;
  signal: AbortSignal;
}

export interface EnqueueOptions {
  /**
   * Transaction đang mở của nghiệp vụ: job chỉ thành hình khi transaction commit, nên không có cảnh dữ liệu đã ghi
   * mà job bị mất (hoặc job chạy mà dữ liệu đã rollback).
   */
  tx?: Tx | undefined;
  /** Với queue policy `stately`: mỗi khoá chỉ một job chờ và một job đang chạy. */
  singletonKey?: string | undefined;
  /** Chưa chạy trước thời điểm này (hẹn giờ kiểm lease, hết hạn đề nghị job). */
  startAfter?: Date | undefined;
}

export interface Jobs {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Trả id của job, hoặc null khi đã có job cùng singletonKey đang chờ. */
  enqueue<T extends object>(queue: string, data: T, opts?: EnqueueOptions): Promise<string | null>;
  /** Đăng ký xử lý. Chỉ gọi ở tiến trình có vai trò `jobs`. */
  work<T>(
    queue: string,
    handler: (job: JobRun<T>) => Promise<void>,
    opts?: { pollingIntervalSeconds?: number },
  ): Promise<void>;
}

export interface JobsOptions {
  /** Kết nối bằng role hive_jobs (HIVE_DATABASE_JOBS_URL). */
  connectionString: string;
  queues: JobQueue[];
  /** Tắt giám sát và lịch nền; tiến trình chỉ gửi job (vai trò api) không cần. */
  maintenance?: boolean;
  onError?: (error: Error) => void;
}

/**
 * pg-boss chạy bằng role hive_jobs riêng (docs/architecture.md mục 3), không bằng hive_owner: tiến trình hub đang
 * chạy không nên giữ quyền DDL trên schema hive, còn pg-boss cần tạo và sửa bảng của nó lúc start. hive_jobs chỉ
 * sở hữu schema pgboss, không đọc được dữ liệu tổ chức.
 */
export function createJobs(opts: JobsOptions): Jobs {
  const maintenance = opts.maintenance ?? true;
  const boss = new PgBoss({
    connectionString: opts.connectionString,
    schema: JOBS_SCHEMA,
    // Schema đã có từ bước bootstrap; CREATE SCHEMA IF NOT EXISTS vẫn đòi quyền CREATE trên database.
    createSchema: false,
    supervise: maintenance,
    schedule: maintenance,
    application_name: "xdev-hive-jobs",
  });
  boss.on("error", (e: Error) => (opts.onError ?? ((err) => console.error("pg-boss:", err)))(e));

  return {
    async start() {
      await boss.start();
      for (const { name, ...options } of opts.queues) {
        if (await boss.getQueue(name)) continue;
        // Hai tiến trình hub cùng khởi động có thể đua nhau tạo; bên thua chỉ cần thấy queue đã có.
        await boss.createQueue(name, options).catch(async (e: unknown) => {
          if (!(await boss.getQueue(name))) throw e;
        });
      }
      // hive_app gửi job ngay trong transaction nghiệp vụ (cùng kết nối), nên cần INSERT vào bảng job. Cấp ở đây,
      // sau khi pg-boss tạo bảng, bằng chính chủ bảng; default privileges phủ bảng pg-boss tạo về sau (partition
      // của queue mới). RETURNING id đòi thêm SELECT.
      await boss.getDb().executeSql(`
        GRANT USAGE ON SCHEMA ${JOBS_SCHEMA} TO hive_app;
        GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA ${JOBS_SCHEMA} TO hive_app;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${JOBS_SCHEMA} TO hive_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${JOBS_SCHEMA} GRANT SELECT, INSERT ON TABLES TO hive_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${JOBS_SCHEMA} GRANT EXECUTE ON FUNCTIONS TO hive_app;
      `);
    },

    async stop() {
      await boss.stop({ graceful: true, timeout: 10_000 });
    },

    async enqueue(queue, data, eo = {}) {
      const options: Parameters<PgBoss["send"]>[2] = {};
      if (eo.singletonKey) options.singletonKey = eo.singletonKey;
      if (eo.startAfter) options.startAfter = eo.startAfter;
      if (eo.tx) {
        const client = eo.tx.$client;
        options.db = { executeSql: (text, values) => client.query(text, values) };
      }
      return boss.send(queue, data, options);
    },

    async work(queue, handler, wo = {}) {
      await boss.work<object>(
        queue,
        { batchSize: 1, pollingIntervalSeconds: wo.pollingIntervalSeconds ?? 2 },
        async ([job]) => {
          if (!job) return;
          await handler({ id: job.id, data: job.data as never, retryCount: job.retryCount, signal: job.signal });
        },
      );
    },
  };
}
