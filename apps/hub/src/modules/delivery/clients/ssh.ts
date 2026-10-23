import { createHash } from "node:crypto";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import ssh2, { type ConnectConfig, type ServerHostKeyAlgorithm, type SFTPWrapper } from "ssh2";
import type { HostKey } from "../schema.ts";
import { deliveryOutbound, OUTBOUND_DISABLED } from "./outbound.ts";

// Client SSH của hub (plan.md mục 5 "Kết nối"; spike T001, research.md mục 4). Khoá riêng chỉ nằm trong bộ nhớ của lần
// kết nối: không ghi file, không log, không đưa vào thông báo lỗi.

export const SSH_READY_TIMEOUT_MS = 10_000;
export const EXEC_TIMEOUT_MS = 60_000;
export const EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
const WRITE_TIMEOUT_MS = 10 * 60_000;
const CLOSE_WAIT_MS = 2_000;
const KEY_COMMENT = "xdev-hive";

export type SshErrorKind =
  | "network"
  | "auth"
  | "hostkey_unconfirmed"
  | "hostkey_changed"
  | "exec_timeout"
  | "output_limit"
  | "sftp";

export class SshError extends Error {
  override readonly name = "SshError";
  readonly kind: SshErrorKind;
  /** Host key máy chủ vừa trình ra, với `hostkey_unconfirmed` và `hostkey_changed`. */
  readonly hostKey: HostKey | undefined;
  /** `level` của ssh2 (`client-socket`, `client-timeout`, `handshake`…), để phân biệt lỗi thương lượng khi dò. */
  readonly level: string | undefined;

  constructor(kind: SshErrorKind, message: string, extra: { hostKey?: HostKey; level?: string; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.kind = kind;
    this.hostKey = extra.hostKey;
    this.level = extra.level;
  }
}

// ---- Khoá, host key -------------------------------------------------------------------------------------------------

/**
 * Cặp ed25519 dạng OpenSSH. Dùng `ssh2.utils` thay cho `crypto.generateKeyPairSync`: ssh2 không đọc khoá PKCS#8 của
 * Node (spike T001).
 */
export function generateServerKey(): { privateKey: string; publicKey: string } {
  const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: KEY_COMMENT });
  return { privateKey: pair.private, publicKey: pair.public.trim() };
}

/** Lệnh quản trị dán vào máy chủ. Khoá công khai chỉ có chữ, số, `+/=` và chú thích cố định nên nằm gọn trong `'…'`. */
export function installCommand(publicKey: string): string {
  return [
    "mkdir -p ~/.ssh",
    "chmod 700 ~/.ssh",
    `echo '${publicKey}' >> ~/.ssh/authorized_keys`,
    "chmod 600 ~/.ssh/authorized_keys",
  ].join(" && ");
}

/** Thuật toán (loại khoá trong blob) và SHA256 đúng dạng `ssh-keygen -lf` in ra. */
export function hostKeyOf(blob: Buffer): HostKey {
  const len = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const algorithm = len > 0 && len + 4 <= blob.length ? blob.subarray(4, 4 + len).toString("latin1") : "unknown";
  return { algorithm, fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
}

/** Loại khoá → thuật toán chữ ký để ép khi thương lượng. Khoá RSA ký bằng rsa-sha2-*; `ssh-rsa` (SHA-1) để cuối. */
const HOST_KEY_ALGORITHMS: Record<string, ServerHostKeyAlgorithm[]> = {
  "ssh-ed25519": ["ssh-ed25519"],
  "ecdsa-sha2-nistp256": ["ecdsa-sha2-nistp256"],
  "ecdsa-sha2-nistp384": ["ecdsa-sha2-nistp384"],
  "ecdsa-sha2-nistp521": ["ecdsa-sha2-nistp521"],
  "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
};

function forcedAlgorithms(hostKeys: readonly HostKey[]): ServerHostKeyAlgorithm[] {
  return [...new Set(hostKeys.flatMap((k) => HOST_KEY_ALGORITHMS[k.algorithm] ?? []))];
}

// ---- Kết nối --------------------------------------------------------------------------------------------------------

export interface SshAddress {
  host: string;
  port: number;
}

export interface SshTarget extends SshAddress {
  user: string;
  privateKey: string;
  /** Host key đã xác nhận. Rỗng thì kết nối dừng ở `hostkey_unconfirmed`, không xác thực, không chạy lệnh. */
  hostKeys: readonly HostKey[];
}

export interface SshOptions {
  readyTimeoutMs?: number | undefined;
}

type Verdict = "accept" | "hostkey_unconfirmed" | "hostkey_changed";

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function classify(
  err: Error & { level?: string; code?: string },
  denied: { verdict: Verdict; hostKey: HostKey } | undefined,
  forced: boolean,
): SshError {
  const level = err.level;
  const extra = { cause: err, ...(level ? { level } : {}) };
  // ssh2 báo chung "Host denied" cho cả "chưa có" và "đã đổi": lý do thật do hostVerifier ghi lại.
  if (denied && denied.verdict !== "accept")
    return new SshError(
      denied.verdict,
      denied.verdict === "hostkey_changed"
        ? "Host key của máy chủ đã đổi. Hub dừng, không chạy lệnh nào."
        : "Hub chưa xác nhận host key của máy chủ này.",
      { ...extra, hostKey: denied.hostKey },
    );
  if (level === "client-authentication") return new SshError("auth", "Máy chủ không nhận khoá SSH của hub.", extra);
  if (level === "handshake" && forced && /host key/i.test(err.message))
    return new SshError(
      "hostkey_changed",
      "Máy chủ không còn host key đã xác nhận. Hub dừng, không chạy lệnh nào.",
      extra,
    );
  if (level === "client-timeout") return new SshError("network", "Hết giờ chờ máy chủ SSH trả lời.", extra);
  if (err.code && NETWORK_CODES.has(err.code))
    return new SshError("network", `Không kết nối được máy chủ (${err.code}).`, extra);
  return new SshError("network", `Kết nối SSH lỗi: ${err.message}`, extra);
}

/** IPv6 trong hợp đồng viết `[…]`; ssh2 cần địa chỉ trần. */
const bareHost = (host: string) => host.replace(/^\[(.*)\]$/, "$1");

interface OpenInput extends SshAddress {
  user: string;
  privateKey?: string | undefined;
  algorithms?: ServerHostKeyAlgorithm[] | undefined;
  verify: (key: HostKey) => Verdict;
  readyTimeoutMs: number;
}

function openClient(input: OpenInput): Promise<SshConnection> {
  return new Promise((resolve, reject) => {
    if (!deliveryOutbound()) {
      reject(new SshError("network", OUTBOUND_DISABLED));
      return;
    }
    const client = new ssh2.Client();
    let denied: { verdict: Verdict; hostKey: HostKey } | undefined;
    let conn: SshConnection | undefined;
    let settled = false;
    const fail = (e: SshError) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(e);
    };
    // Gắn suốt đời kết nối, không dùng `once`: sau lỗi hết giờ ssh2 còn phát thêm "Connection lost before handshake",
    // listener `once` đã gỡ thì lỗi đó làm sập tiến trình hub (spike T001).
    client.on("error", (err) => {
      if (!settled) fail(classify(err, denied, Boolean(input.algorithms)));
      else conn?.lost(new SshError("network", `Mất kết nối SSH: ${err.message}`, { cause: err }));
    });
    client.on("close", () => {
      if (!settled) fail(new SshError("network", "Máy chủ đóng kết nối trước khi sẵn sàng."));
      else conn?.lost(new SshError("network", "Mất kết nối SSH."));
    });
    client.on("ready", () => {
      if (settled) return;
      settled = true;
      conn = new SshConnection(client, denied?.hostKey);
      resolve(conn);
    });
    const config: ConnectConfig = {
      host: bareHost(input.host),
      port: input.port,
      username: input.user,
      readyTimeout: input.readyTimeoutMs,
      hostVerifier: (blob: Buffer) => {
        const hostKey = hostKeyOf(blob);
        denied = { verdict: input.verify(hostKey), hostKey };
        return denied.verdict === "accept";
      },
    };
    if (input.privateKey !== undefined) config.privateKey = input.privateKey;
    if (input.algorithms) config.algorithms = { serverHostKey: input.algorithms };
    try {
      client.connect(config);
    } catch (e) {
      // Khoá đã lưu hỏng: không đưa câu lỗi gốc của ssh2 ra ngoài phòng khi có mảnh khoá.
      fail(new SshError("auth", "Khoá SSH đã lưu của máy chủ không đọc được. Đổi khoá cho máy chủ này.", { cause: e }));
    }
  });
}

/**
 * Mở kết nối đã xác thực. Host key so với `hostKeys` trước khi gửi khoá: không khớp thì dừng (`hostkey_changed`), chưa
 * có thì `hostkey_unconfirmed`, không lệnh nào chạy.
 */
export function connectSsh(target: SshTarget, options: SshOptions = {}): Promise<SshConnection> {
  const known = target.hostKeys;
  return openClient({
    host: target.host,
    port: target.port,
    user: target.user,
    privateKey: target.privateKey,
    // Ép thuật toán đã lưu: máy có nhiều host key thì thương lượng sang khoá khác sẽ bị báo nhầm "host key đổi".
    algorithms: known.length ? forcedAlgorithms(known) : undefined,
    verify: (k) =>
      known.length === 0
        ? "hostkey_unconfirmed"
        : known.some((h) => h.fingerprint === k.fingerprint)
          ? "accept"
          : "hostkey_changed",
    readyTimeoutMs: options.readyTimeoutMs ?? SSH_READY_TIMEOUT_MS,
  });
}

/** Mở, làm việc, luôn đóng. */
export async function withSsh<T>(
  target: SshTarget,
  run: (conn: SshConnection) => Promise<T>,
  options: SshOptions = {},
): Promise<T> {
  const conn = await connectSsh(target, options);
  try {
    return await run(conn);
  } finally {
    await conn.close();
  }
}

/**
 * Host key máy chủ trình ra với từng loại khoá hub hỗ trợ, để quản trị đối chiếu. Mỗi lần dừng ở hostVerifier: không
 * gửi khoá, không xác thực.
 */
export async function probeHostKeys(address: SshAddress, options: SshOptions = {}): Promise<HostKey[]> {
  const found: HostKey[] = [];
  for (const algorithms of Object.values(HOST_KEY_ALGORITHMS)) {
    try {
      const conn = await openClient({
        ...address,
        user: "xdev-hive-probe",
        algorithms,
        verify: () => "hostkey_unconfirmed",
        readyTimeoutMs: options.readyTimeoutMs ?? SSH_READY_TIMEOUT_MS,
      });
      await conn.close();
    } catch (e) {
      if (!(e instanceof SshError)) throw e;
      if (e.kind === "hostkey_unconfirmed" && e.hostKey) {
        if (!found.some((k) => k.fingerprint === e.hostKey?.fingerprint)) found.push(e.hostKey);
        continue;
      }
      // Máy chủ không có loại khoá này: thử loại kế tiếp. Lỗi mạng thì dừng luôn.
      if (e.level === "handshake") continue;
      throw e;
    }
  }
  if (!found.length) throw new SshError("network", "Máy chủ không trình host key nào hub hỗ trợ.");
  return found;
}

// ---- Lệnh và SFTP ---------------------------------------------------------------------------------------------------

export interface ExecOptions {
  timeoutMs?: number | undefined;
  /** Tổng byte stdout + stderr; vượt thì đóng kênh và báo `output_limit`. */
  maxOutputBytes?: number | undefined;
  stdin?: string | Buffer | undefined;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export type WriteSource = string | Buffer | Readable | WebReadableStream<Uint8Array> | ReadableStream<Uint8Array>;

export interface WriteOptions {
  /** Luôn đặt quyền: không đặt thì file theo umask của máy chủ (spike T001). Mặc định 600. */
  mode?: number | undefined;
  timeoutMs?: number | undefined;
}

type Reject = (e: SshError) => void;

export class SshConnection {
  readonly #client: InstanceType<typeof ssh2.Client>;
  readonly #pending = new Set<Reject>();
  #lostError: SshError | undefined;
  #closed: Promise<void> | undefined;
  #sftp: Promise<SFTPWrapper> | undefined;
  /** Host key đã khớp ở lần kết nối này. */
  readonly hostKey: HostKey | undefined;

  constructor(client: InstanceType<typeof ssh2.Client>, hostKey: HostKey | undefined) {
    this.#client = client;
    this.hostKey = hostKey;
  }

  /** Kết nối đứt: mọi thao tác đang chờ báo lỗi ngay thay vì treo (spike T001: `pipeline` SFTP treo vĩnh viễn). */
  lost(e: SshError): void {
    this.#lostError ??= e;
    for (const reject of this.#pending) reject(e);
    this.#pending.clear();
  }

  #track<T>(run: (resolve: (v: T) => void, reject: Reject) => void, onLost?: (e: SshError) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#lostError) return reject(this.#lostError);
      let done = false;
      const settle: Reject = (e) => {
        if (done) return;
        done = true;
        this.#pending.delete(settle);
        onLost?.(e);
        reject(e);
      };
      this.#pending.add(settle);
      run((v) => {
        if (done) return;
        done = true;
        this.#pending.delete(settle);
        resolve(v);
      }, settle);
    });
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? EXEC_TIMEOUT_MS;
    const max = options.maxOutputBytes ?? EXEC_MAX_OUTPUT_BYTES;
    return this.#track<ExecResult>((resolve, reject) => {
      this.#client.exec(command, (err, stream) => {
        if (err) return reject(new SshError("network", `Không mở được kênh chạy lệnh: ${err.message}`, { cause: err }));
        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        let size = 0;
        let code: number | null = null;
        let signal: string | null = null;
        const timer = setTimeout(() => {
          stream.close();
          reject(new SshError("exec_timeout", `Lệnh chạy quá ${Math.round(timeoutMs / 1000)} giây.`));
        }, timeoutMs);
        const take = (into: Buffer[]) => (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            clearTimeout(timer);
            stream.close();
            reject(new SshError("output_limit", `Lệnh in quá ${max} byte.`));
            return;
          }
          into.push(chunk);
        };
        // Phải đọc cả stdout và stderr: không đọc thì `close` không phát và lệnh treo (spike T001).
        stream.on("data", take(out));
        stream.stderr.on("data", take(errOut));
        stream.on("exit", (c: number | null, s?: string) => {
          code = typeof c === "number" ? c : null;
          signal = s ?? null;
        });
        stream.on("close", () => {
          clearTimeout(timer);
          // Gom đủ byte rồi mới giải mã: cắt giữa ký tự UTF-8 nhiều byte sẽ ra ký tự lỗi.
          resolve({
            code,
            signal,
            stdout: Buffer.concat(out).toString("utf8"),
            stderr: Buffer.concat(errOut).toString("utf8"),
          });
        });
        if (options.stdin !== undefined) stream.end(options.stdin);
        else stream.end();
      });
    });
  }

  #sftpSession(): Promise<SFTPWrapper> {
    this.#sftp ??= this.#track<SFTPWrapper>((resolve, reject) => {
      this.#client.sftp((err, sftp) => {
        if (err) reject(new SshError("sftp", `Không mở được SFTP: ${err.message}`, { cause: err }));
        else resolve(sftp);
      });
    });
    return this.#sftp;
  }

  #sftpCall(label: string, run: (sftp: SFTPWrapper, cb: (err?: Error | null) => void) => void): Promise<void> {
    return this.#sftpSession().then((sftp) =>
      this.#track<void>((resolve, reject) =>
        run(sftp, (err) =>
          err ? reject(new SshError("sftp", `SFTP ${label} lỗi: ${err.message}`, { cause: err })) : resolve(),
        ),
      ),
    );
  }

  #isDir(path: string): Promise<boolean> {
    return this.#sftpSession().then((sftp) =>
      this.#track<boolean>((resolve) => sftp.stat(path, (err, st) => resolve(!err && st.isDirectory()))),
    );
  }

  /** SFTP không tạo đệ quy: `recursive` tạo từng cấp, bỏ qua cấp đã có. */
  async mkdir(path: string, options: { mode?: number; recursive?: boolean } = {}): Promise<void> {
    const mode = options.mode ?? 0o700;
    const make = async (p: string) => {
      try {
        await this.#sftpCall(`mkdir ${p}`, (sftp, cb) => sftp.mkdir(p, { mode }, cb));
      } catch (e) {
        if (!(options.recursive && (await this.#isDir(p)))) throw e;
      }
    };
    if (!options.recursive) return make(path);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (p && p !== "~") await make(p);
    }
  }

  chmod(path: string, mode: number): Promise<void> {
    return this.#sftpCall(`chmod ${path}`, (sftp, cb) => sftp.chmod(path, mode, cb));
  }

  /** Ghi file từ chuỗi, Buffer hoặc stream (vd. tarball của `git archive`). Mất kết nối hay quá giờ thì huỷ stream. */
  async writeFile(path: string, source: WriteSource, options: WriteOptions = {}): Promise<void> {
    const sftp = await this.#sftpSession();
    const input =
      typeof source === "string" || Buffer.isBuffer(source)
        ? Readable.from([Buffer.from(source)], { objectMode: false })
        : source instanceof Readable
          ? source
          : Readable.fromWeb(source as WebReadableStream<Uint8Array>);
    const output = sftp.createWriteStream(path, { mode: options.mode ?? 0o600 });
    const timeoutMs = options.timeoutMs ?? WRITE_TIMEOUT_MS;
    const abort = (e: SshError) => {
      // Kiểu của ssh2 khai `destroy()` không tham số; WriteStream thật là Writable nên nhận lỗi để pipeline dừng.
      (output as unknown as Writable).destroy(e);
      input.destroy(e);
    };
    await this.#track<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new SshError("sftp", `Ghi ${path} quá ${Math.round(timeoutMs / 1000)} giây.`);
        abort(e);
        reject(e);
      }, timeoutMs);
      pipeline(input, output).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: Error) => {
          clearTimeout(timer);
          reject(
            err instanceof SshError ? err : new SshError("sftp", `Ghi ${path} lỗi: ${err.message}`, { cause: err }),
          );
        },
      );
    }, abort);
  }

  /** Đóng và chờ socket đóng (có hạn), để test và job theo dõi không để lại kết nối treo. */
  close(): Promise<void> {
    this.#closed ??= new Promise<void>((resolve) => {
      if (this.#lostError) return resolve();
      const timer = setTimeout(resolve, CLOSE_WAIT_MS);
      this.#client.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.#client.end();
    });
    return this.#closed;
  }
}
