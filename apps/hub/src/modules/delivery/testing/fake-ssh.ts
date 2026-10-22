import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import ssh2, { type AuthContext, type Connection, type ParsedKey, type SFTPWrapper } from "ssh2";

// Máy chủ SSH giả trong tiến trình (`Server` của ssh2), chỉ nghe 127.0.0.1 cổng ngẫu nhiên: test không bao giờ kết nối
// máy thật. Ghi lại mọi lệnh và file để test kiểm "host key sai thì không lệnh nào chạy".

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;

export interface FakeExecReply {
  stdout?: string | Buffer;
  stderr?: string;
  code?: number;
  /** Không trả lời, không đóng kênh: thử hạn giờ của `exec`. */
  hang?: boolean;
}

export interface FakeSshOptions {
  /** Khoá riêng host key; mặc định một khoá ed25519 mới. */
  hostKeys?: string[];
  user?: string;
  /** Dòng `authorized_keys` hiện hành; gọi lại ở mỗi lần xác thực để test đổi khoá giữa chừng. */
  authorizedKeys: () => string[];
  exec?: (command: string) => FakeExecReply | Promise<FakeExecReply>;
  /** Đóng kết nối ngay khi nhận gói ghi SFTP đầu tiên. */
  dropOnWrite?: boolean;
}

export interface FakeFile {
  data: Buffer;
  mode: number;
}

export interface FakeSsh {
  host: string;
  port: number;
  /** `{algorithm, fingerprint}` của từng host key, theo thứ tự `hostKeys`. */
  hostKeys: { algorithm: string; fingerprint: string }[];
  commands: string[];
  files: Map<string, FakeFile>;
  dirs: Set<string>;
  /** Số lần client xác thực thành công. */
  logins: number;
  close(): Promise<void>;
}

export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function parsed(key: string): ParsedKey {
  const k = utils.parseKey(key);
  if (k instanceof Error) throw k;
  return Array.isArray(k) ? (k[0] as ParsedKey) : k;
}

export async function startFakeSsh(options: FakeSshOptions): Promise<FakeSsh> {
  const hostKeys = options.hostKeys ?? [utils.generateKeyPairSync("ed25519").private];
  const user = options.user ?? "deploy";
  const state: FakeSsh = {
    host: "127.0.0.1",
    port: 0,
    hostKeys: hostKeys.map((k) => {
      const key = parsed(k);
      return { algorithm: key.type, fingerprint: fingerprintOf(key.getPublicSSH()) };
    }),
    commands: [],
    files: new Map(),
    dirs: new Set(),
    logins: 0,
    close: async () => {},
  };
  const clients = new Set<Connection>();

  const authenticate = (ctx: AuthContext) => {
    if (ctx.method !== "publickey" || ctx.username !== user) return ctx.reject(["publickey"]);
    const match = options
      .authorizedKeys()
      .map(parsed)
      .find((k) => k.type === ctx.key.algo && k.getPublicSSH().equals(ctx.key.data));
    if (!match) return ctx.reject(["publickey"]);
    if (!ctx.signature) return ctx.accept();
    if (match.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(["publickey"]);
    state.logins++;
    ctx.accept();
  };

  const server = new Server({ hostKeys }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", authenticate);
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("exec", async (accept, _reject, info) => {
          const stream = accept();
          state.commands.push(info.command);
          const reply = (await options.exec?.(info.command)) ?? {};
          if (reply.hang) return;
          if (reply.stdout !== undefined) stream.write(reply.stdout);
          if (reply.stderr !== undefined) stream.stderr.write(reply.stderr);
          stream.exit(reply.code ?? 0);
          stream.end();
        });
        session.on("sftp", (acceptSftp) => serveSftp(acceptSftp(), state, () => options.dropOnWrite && client.end()));
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const c of clients) c.end();
      server.close(() => resolve());
    });
  return state;
}

function serveSftp(sftp: SFTPWrapper, state: FakeSsh, onWrite: () => unknown) {
  const handles = new Map<number, string>();
  let next = 0;
  const handleId = (h: Buffer) => handles.get(h.readUInt32BE(0));
  sftp.on("OPEN", (reqid, filename, _flags, attrs) => {
    const id = next++;
    handles.set(id, filename);
    state.files.set(filename, { data: Buffer.alloc(0), mode: attrs.mode ?? 0o664 });
    const h = Buffer.alloc(4);
    h.writeUInt32BE(id);
    sftp.handle(reqid, h);
  });
  sftp.on("WRITE", (reqid, handle, offset, data) => {
    if (onWrite()) return;
    const file = state.files.get(handleId(handle) ?? "");
    if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const end = offset + data.length;
    if (file.data.length < end) file.data = Buffer.concat([file.data, Buffer.alloc(end - file.data.length)]);
    data.copy(file.data, offset);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("FSETSTAT", (reqid, handle, attrs) => {
    const file = state.files.get(handleId(handle) ?? "");
    if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (attrs.mode !== undefined) file.mode = attrs.mode;
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("SETSTAT", (reqid, path, attrs) => {
    const file = state.files.get(path);
    if (file && attrs.mode !== undefined) file.mode = attrs.mode;
    sftp.status(reqid, file || state.dirs.has(path) ? STATUS_CODE.OK : STATUS_CODE.NO_SUCH_FILE);
  });
  sftp.on("CLOSE", (reqid, handle) => {
    handles.delete(handle.readUInt32BE(0));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on("MKDIR", (reqid, path) => {
    if (state.dirs.has(path) || state.files.has(path)) return sftp.status(reqid, STATUS_CODE.FAILURE);
    state.dirs.add(path);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  const stat = (reqid: number, path: string) => {
    if (state.dirs.has(path)) return sftp.attrs(reqid, attrs(0o040755, 0));
    const file = state.files.get(path);
    if (file) return sftp.attrs(reqid, attrs(0o100000 | file.mode, file.data.length));
    sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
  };
  sftp.on("STAT", stat);
  sftp.on("LSTAT", stat);
}

function attrs(mode: number, size: number) {
  return { mode, size, uid: 0, gid: 0, atime: 0, mtime: 0 };
}
