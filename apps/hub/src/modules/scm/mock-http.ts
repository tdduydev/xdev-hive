// Chỉ dùng trong test: giả lập HTTP bằng MockAgent, không đụng dispatcher toàn cục và không ra mạng.
import { MockAgent, fetch as undiciFetch } from "undici";
import type { FetchLike } from "./types.ts";

export interface Captured {
  method: string;
  path: string;
  body: unknown;
}

export function mockHttp() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const calls: Captured[] = [];
  const fetch: FetchLike = async (input, init) => {
    const res = await undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never);
    return res as unknown as Response;
  };
  /** Ghi lại thân yêu cầu để test kiểm, rồi trả phản hồi JSON. */
  const json =
    (data: unknown) =>
    (opts: { method: string; path: string; body?: unknown }): unknown => {
      const raw = typeof opts.body === "string" ? opts.body : undefined;
      calls.push({ method: opts.method, path: opts.path, body: raw ? JSON.parse(raw) : undefined });
      return data;
    };
  return { agent, fetch, calls, json };
}

export const JSON_HEADERS = { headers: { "content-type": "application/json" } };
