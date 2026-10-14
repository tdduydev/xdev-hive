// Máy chủ giả cho API Telegram Bot và Slack Web API, dùng chung cho test adapter và test database của module chat.
// Chạy thật qua HTTP trên cổng ngẫu nhiên để adapter đi đúng đường fetch như production.
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeCall {
  api: "telegram" | "slack" | "response";
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeChatApis {
  /** Truyền vào `telegramApi`. */
  telegramApi: string;
  /** Truyền vào `slackApi`. */
  slackApi: string;
  /** URL giả cho `response_url` của Slack. */
  responseUrl: string;
  calls: FakeCall[];
  /** Gọi theo loại: `sent("telegram")` là các sendMessage, `sent("slack")` là chat.postMessage. */
  sent(api: "telegram" | "slack"): FakeCall[];
  /** Telegram trả lần lượt các mã HTTP này cho sendMessage, hết thì 200. */
  failTelegram(...statuses: number[]): void;
  /** Slack trả lần lượt các mã lỗi này cho chat.postMessage (HTTP 200, ok=false), hết thì ok. */
  failSlack(...errors: string[]): void;
  reset(): void;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startFakeChatApis(): Promise<FakeChatApis> {
  const calls: FakeCall[] = [];
  let telegramStatuses: number[] = [];
  let slackErrors: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const body = await readJson(req);
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    const tg = /^\/bot([^/]+)\/(\w+)$/.exec(url);
    if (tg?.[2]) {
      calls.push({ api: "telegram", method: tg[2], body, headers: req.headers });
      if (tg[2] === "getMe") return reply(200, { ok: true, result: { username: "hive_test_bot" } });
      if (tg[2] === "sendMessage") {
        const status = telegramStatuses.shift() ?? 200;
        if (status !== 200) return reply(status, { ok: false, error_code: status, description: "lỗi giả" });
        return reply(200, { ok: true, result: { message_id: calls.length } });
      }
      return reply(200, { ok: true, result: true });
    }
    const slack = /^\/slack\/([\w.]+)$/.exec(url);
    if (slack?.[1]) {
      calls.push({ api: "slack", method: slack[1], body, headers: req.headers });
      if (slack[1] === "auth.test") return reply(200, { ok: true, team: "Acme", user: "hive" });
      if (slack[1] === "chat.postMessage") {
        const error = slackErrors.shift();
        return reply(200, error ? { ok: false, error } : { ok: true, ts: "1.1" });
      }
      return reply(200, { ok: true });
    }
    if (url.startsWith("/response")) {
      calls.push({ api: "response", method: "post", body, headers: req.headers });
      return reply(200, { ok: true });
    }
    return reply(404, { ok: false });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    telegramApi: base,
    slackApi: `${base}/slack`,
    responseUrl: `${base}/response/1`,
    calls,
    sent: (api) => calls.filter((c) => c.method === (api === "telegram" ? "sendMessage" : "chat.postMessage")),
    failTelegram: (...statuses) => {
      telegramStatuses = statuses;
    },
    failSlack: (...errors) => {
      slackErrors = errors;
    },
    reset: () => {
      calls.length = 0;
      telegramStatuses = [];
      slackErrors = [];
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Header ký request Slack theo quy ước v0 (https://api.slack.com/authentication/verifying-requests-from-slack). */
export function slackHeaders(signingSecret: string, rawBody: string, opts: { ts?: number; retry?: boolean } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", signingSecret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  return {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": sig,
    ...(opts.retry ? { "x-slack-retry-num": "1" } : {}),
  } as Record<string, string>;
}
