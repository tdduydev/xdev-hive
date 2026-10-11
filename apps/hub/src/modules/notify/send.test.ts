import { once } from "node:events";
import { type AddressInfo, createServer, type Server } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChannelConfig, DeliveryError, type FetchLike, send, targetOf, telegramText } from "./send.ts";

const telegram: ChannelConfig = {
  kind: "telegram",
  botToken: "123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789",
  chatId: "-1001234",
};
const msg = { title: "Run R-1 lỗi", body: "Kiểm tra a < b && c > d", link: "https://hive.example.com/runs/1?a=1&b=2" };

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn: FetchLike = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

async function rejected(p: Promise<unknown>): Promise<DeliveryError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DeliveryError);
    return e as DeliveryError;
  }
  throw new Error("cần lỗi DeliveryError");
}

describe("Telegram", () => {
  it("gửi sendMessage HTML, thoát ký tự đặc biệt trong tiêu đề, nội dung và link", async () => {
    const { fn, calls } = fakeFetch(200, { ok: true });
    await send(telegram, msg, { fetch: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`);
    expect(calls[0]?.body).toMatchObject({ chat_id: "-1001234", parse_mode: "HTML", disable_web_page_preview: true });
    expect(calls[0]?.body.text).toBe(
      '<b>Run R-1 lỗi</b>\n\nKiểm tra a &lt; b &amp;&amp; c &gt; d\n\n<a href="https://hive.example.com/runs/1?a=1&amp;b=2">Mở trong xDev Hive</a>',
    );
  });

  it("tin dài được cắt vừa 4096 ký tự, không cắt giữa thực thể HTML", () => {
    const text = telegramText({ title: "T", body: "&".repeat(5000), link: null });
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith("&amp;…")).toBe(true);
  });

  it("token sai (401) là lỗi vĩnh viễn; 429 và 5xx là tạm thời; lỗi không chứa token", async () => {
    const e401 = await rejected(
      send(telegram, msg, { fetch: fakeFetch(401, { ok: false, description: "Unauthorized" }).fn }),
    );
    expect(e401.permanent).toBe(true);
    expect(e401.message).toContain("Unauthorized");
    for (const status of [429, 502]) {
      const e = await rejected(send(telegram, msg, { fetch: fakeFetch(status, { ok: false }).fn }));
      expect(e.permanent).toBe(false);
    }
    const leaky: FetchLike = async (input) => {
      throw new Error(`không mở được ${String(input)}`);
    };
    const net = await rejected(send(telegram, msg, { fetch: leaky }));
    expect(net.permanent).toBe(false);
    expect(net.message).not.toContain(telegram.botToken);
  });
});

// ---- SMTP giả ------------------------------------------------------------------------------------------------

interface Mail {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
}

/** Máy chủ SMTP tối thiểu, không TLS: đủ cho nodemailer gửi một thư, có AUTH PLAIN/LOGIN. */
async function smtpServer(replies: { rcpt?: string; data?: string; auth?: string } = {}) {
  const mails: Mail[] = [];
  const server: Server = createServer((sock) => {
    sock.setEncoding("utf8");
    const w = (s: string) => sock.write(`${s}\r\n`);
    let buf = "";
    let inData = false;
    let login: string[] | null = null;
    let cur: Mail = { from: "", to: [], data: "", auth: null };
    w("220 smtp.test ESMTP");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            mails.push(cur);
            cur = { from: "", to: [], data: "", auth: cur.auth };
            w(replies.data ?? "250 OK");
          } else cur.data += `${line.replace(/^\./, "")}\n`;
          continue;
        }
        if (login) {
          login.push(Buffer.from(line, "base64").toString());
          if (login.length === 1) w("334 UGFzc3dvcmQ6");
          else {
            cur.auth = `\0${login[0]}\0${login[1]}`;
            login = null;
            w(replies.auth ?? "235 OK");
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) {
          w("250-smtp.test");
          w("250 AUTH PLAIN LOGIN");
        } else if (cmd.startsWith("AUTH PLAIN ")) {
          cur.auth = Buffer.from(line.slice(11), "base64").toString();
          w(replies.auth ?? "235 OK");
        } else if (cmd === "AUTH LOGIN") {
          login = [];
          w("334 VXNlcm5hbWU6");
        } else if (cmd.startsWith("MAIL FROM")) {
          cur.from = line;
          w("250 OK");
        } else if (cmd.startsWith("RCPT TO")) {
          cur.to.push(line);
          w(replies.rcpt ?? "250 OK");
        } else if (cmd === "DATA") {
          inData = true;
          w("354 Gửi đi");
        } else if (cmd === "QUIT") {
          w("221 Tạm biệt");
          sock.end();
        } else if (cmd === "RSET" || cmd === "NOOP") w("250 OK");
        // Máy chủ không có TLS: STARTTLS và lệnh lạ đều bị từ chối như máy chủ thật.
        else w("502 Lệnh không hỗ trợ");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  servers.push(server);
  return { port, mails };
}

const servers: Server[] = [];

/** Nội dung thư có tiếng Việt được mã hoá quoted-printable. */
const unQP = (s: string) =>
  s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) s.close();
});

const email = (port: number, extra: Partial<Extract<ChannelConfig, { kind: "email" }>> = {}): ChannelConfig => ({
  kind: "email",
  host: "127.0.0.1",
  port,
  tls: "none",
  user: "hive",
  password: "mat-khau-smtp",
  from: "hive@example.com",
  to: ["lan@example.com", "minh@example.com"],
  ...extra,
});

describe("Email", () => {
  it("DNS trả địa chỉ nội bộ: lỗi vĩnh viễn trước khi mở transport", async () => {
    const transport = vi.spyOn(nodemailer, "createTransport");
    const lookup = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]);
    const error = await rejected(send(email(587, { host: "smtp.example.com" }), msg, { lookup }));
    expect(error).toMatchObject({ permanent: true, message: "Máy chủ SMTP trỏ vào địa chỉ nội bộ" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("bật cờ cho phép SMTP giả; kết nối IP đã kiểm với tên TLS gốc và không lookup lại", async () => {
    const smtp = await smtpServer();
    const transport = vi.spyOn(nodemailer, "createTransport");
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }])
      .mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await send(email(smtp.port, { host: "smtp.example.com" }), msg, { lookup, allowPrivate: true });
    expect(smtp.mails).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "127.0.0.1",
        tls: { servername: "smtp.example.com" },
      }),
    );
  });

  it("DNS lỗi là lỗi gửi tạm thời", async () => {
    const lookup = async () => {
      throw new Error("DNS lỗi");
    };
    expect((await rejected(send(email(587), msg, { lookup }))).permanent).toBe(false);
  });

  it("gửi tới mọi người nhận, có đăng nhập, tiêu đề và link trong nội dung", async () => {
    const smtp = await smtpServer();
    await send(email(smtp.port), msg, { allowPrivate: true });
    expect(smtp.mails).toHaveLength(1);
    const [mail] = smtp.mails;
    expect(mail?.from).toContain("hive@example.com");
    expect(mail?.to.join(" ")).toMatch(/lan@example\.com.*minh@example\.com/);
    expect(mail?.auth).toBe("\0hive\0mat-khau-smtp");
    expect(mail?.data).toContain("Subject:");
    expect(unQP(mail?.data ?? "")).toContain("https://hive.example.com/runs/1?a=1&b=2");
  });

  it("starttls bắt buộc: máy chủ không có STARTTLS thì không gửi mật khẩu qua kênh trần", async () => {
    const smtp = await smtpServer();
    const e = await rejected(send(email(smtp.port, { tls: "starttls" }), msg, { allowPrivate: true }));
    expect(smtp.mails).toHaveLength(0);
    expect(e.message).not.toContain("mat-khau-smtp");
  });

  it("người nhận bị từ chối (5xx) là vĩnh viễn; 4xx là tạm thời; sai mật khẩu là vĩnh viễn", async () => {
    const r550 = await smtpServer({ rcpt: "550 Không có hộp thư" });
    expect((await rejected(send(email(r550.port), msg, { allowPrivate: true }))).permanent).toBe(true);
    const r451 = await smtpServer({ data: "451 Thử lại sau" });
    expect((await rejected(send(email(r451.port), msg, { allowPrivate: true }))).permanent).toBe(false);
    const bad = await smtpServer({ auth: "535 Sai mật khẩu" });
    const e = await rejected(send(email(bad.port), msg, { allowPrivate: true }));
    expect(e.permanent).toBe(true);
    expect(e.message).not.toContain("mat-khau-smtp");
  });

  it("không kết nối được máy chủ là lỗi tạm thời", async () => {
    const smtp = await smtpServer();
    for (const s of servers.splice(0)) s.close();
    const e = await rejected(send(email(smtp.port), msg, { allowPrivate: true }));
    expect(e.permanent).toBe(false);
  });
});

describe("targetOf", () => {
  it("mô tả nơi nhận, không có secret", () => {
    expect(targetOf(telegram)).toBe("Telegram -1001234");
    const t = targetOf(email(587));
    expect(t).toBe("lan@example.com, minh@example.com qua 127.0.0.1:587");
    expect(t).not.toContain("mat-khau-smtp");
  });
});
